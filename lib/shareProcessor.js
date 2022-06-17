const Redis = require('ioredis');
const HttpClient = require('./httpClient');
const util = require('./util');
const { Pool } = require('pg');

var ShareProcessor = module.exports = function ShareProcessor(config, logger){
    var confirmationTime = config.confirmationTime * 1000;
    var rewardPercent = 1 - config.withholdPercent;

    var _this = this;
    this.redisClient = new Redis(config.redis.port, config.redis.host, {db: config.redis.db});
    this.httpClient = new HttpClient(config.daemon.host, config.daemon.port, config.daemon.apiKey);

    function createTables(db){
        var tables =
            `CREATE TABLE IF NOT EXISTS "shares" (
                "from_group" SMALLINT NOT NULL,
                "to_group" SMALLINT NOT NULL,
                "pool_diff" NUMERIC(13, 8) NOT NULL,
                "share_diff" NUMERIC(13, 8) NOT NULL,
                "worker" VARCHAR(64) NOT NULL,
                "found_block" BOOLEAN NOT NULL,
                "created_date" TIMESTAMP,
                "modified_date" TIMESTAMP,
                "id" SERIAL PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS "blocks" (
                "share_id" INTEGER NOT NULL,
                "from_group" SMALLINT NOT NULL,
                "to_group" SMALLINT NOT NULL,
                "block_hash" CHAR(64) NOT NULL,
                "worker" VARCHAR(64) NOT NULL,
                "created_date" TIMESTAMP,
                "modified_date" TIMESTAMP,
                "id" SERIAL PRIMARY KEY
            );`;
        db.query(tables, function(error, _){
            if (error) {
                logger.error('Create table error: ' + error);
                process.exit(1);
            }
        });
    }

    function persistShare(db, share){
        db.query(
            'INSERT INTO shares(from_group, to_group, pool_diff, share_diff, worker, found_block, created_date, modified_date) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [share.job.fromGroup, share.job.toGroup, share.difficulty, share.shareDiff, share.workerAddress, share.foundBlock, new Date(), new Date()],
            function(error, result){
                if (error) {
                    logger.error('Persist share error: ' + error);
                    return;
                }

                if (share.foundBlock){
                    var shareId = result.rows[0].id;
                    db.query(
                        'INSERT INTO blocks(share_id, from_group, to_group, block_hash, worker, created_date, modified_date) VALUES($1, $2, $3, $4, $5, $6, $7)',
                        [shareId, share.job.fromGroup, share.job.toGroup, share.blockHash, share.workerAddress, new Date(), new Date()],

                        function(error, _){
                            if (error) logger.error('Persist block error: ' + error);
                        }
                    );
                }
            }
        );
    }

    if (config.persistence && config.persistence.enabled) {
        _this.db = new Pool(config.persistence);
        createTables(_this.db);
        _this.handleShare = function(share){
            persistShare(_this.db, share);
            _this._handleShare(share);
        }
    }
    else {
        _this.handleShare = share => _this._handleShare(share);
    }

    this.currentRoundKey = function(fromGroup, toGroup){
        return fromGroup + ':' + toGroup + ':shares:currentRound';
    }

    this.roundKey = function(fromGroup, toGroup, blockHash){
        return fromGroup + ':' + toGroup + ':shares:' + blockHash;
    }

    var pendingBlocksKey = 'pendingBlocks';
    var foundBlocksKey = 'foundBlocks';
    var hashrateKey = 'hashrate';
    var balancesKey = 'balances';

    this._handleShare = function(share){
        var redisTx = _this.redisClient.multi();
        var currentMs = Date.now();
        var fromGroup = share.job.fromGroup;
        var toGroup = share.job.toGroup;
        var currentRound = _this.currentRoundKey(fromGroup, toGroup);
        redisTx.hincrbyfloat(currentRound, share.workerAddress, share.difficulty);

        var currentTs = Math.floor(currentMs / 1000);
        redisTx.zadd(hashrateKey, currentTs, [fromGroup, toGroup, share.worker, share.difficulty, currentMs].join(':'));

        if (share.foundBlock){
            var blockHash = share.blockHash;
            var newKey = _this.roundKey(fromGroup, toGroup, blockHash);
            var blockWithTs = blockHash + ':' + currentMs.toString();

            redisTx.rename(currentRound, newKey);
            redisTx.sadd(pendingBlocksKey, blockWithTs);
            redisTx.hset(foundBlocksKey, blockHash, share.workerAddress)
        }
        redisTx.exec(function(error, _){
            if (error) logger.error('Handle share failed, error: ' + error);
        });
    }

    function handleBlock(block, callback){
        var transactions = block.transactions;
        var rewardTx = transactions[transactions.length - 1];
        var rewardOutput = rewardTx.unsigned.fixedOutputs[0];
        var blockData = {
            hash: block.hash,
            fromGroup: block.chainFrom,
            toGroup: block.chainTo,
            height: block.height,
            rewardAmount: rewardOutput.attoAlphAmount // string
        };
        callback(blockData);
    }

    // remove block shares and remove blockHash from pendingBlocks
    function removeBlockAndShares(fromGroup, toGroup, blockHash, blockHashWithTs){
        _this.redisClient
            .multi()
            .del(_this.roundKey(fromGroup, toGroup, blockHash))
            .srem(pendingBlocksKey, blockHashWithTs)
            .hdel(foundBlocksKey, blockHash)
            .exec(function(error, _){
                if (error) logger.error('Remove block shares failed, error: ' + error + ', blockHash: ' + blockHash);
            })
    }

    this.getPendingBlocks = function(results, callback){
        var blocksNeedToReward = [];
        util.executeForEach(results, function(blockHashWithTs, callback){
            var array = blockHashWithTs.split(':');
            var blockHash = array[0];
            var blockSubmitTs = parseInt(array[1]);
            var now = Date.now();

            if (now < (blockSubmitTs + confirmationTime)){
                // the block reward might be locked, skip and
                // try to reward in the next loop
                callback();
                return;
            }

            _this.httpClient.blockInMainChain(blockHash, function(result){
                if (result.error){
                    logger.error('Check block in main chain error: ' + result.error);
                    callback();
                    return;
                }

                if (!result){
                    logger.error('Block is not in mainchain, remove block and shares, hash: ' + blockHash);
                    var [fromGroup, toGroup] = util.blockChainIndex(Buffer.from(blockHash, 'hex'));
                    removeBlockAndShares(fromGroup, toGroup, blockHash, blockHashWithTs);
                    callback();
                    return;
                }

                _this.httpClient.getBlock(blockHash, function(result){
                    if (result.error){
                        logger.error('Get block error: ' + result.error + ', hash: ' + blockHash);
                        callback();
                        return;
                    }

                    handleBlock(result, function(blockData){
                        var block = {
                            pendingBlockValue: blockHashWithTs,
                            data: blockData
                        };
                        blocksNeedToReward.push(block);
                        callback();
                    });
                });
            });
        }, _ => callback(blocksNeedToReward));
    }

    this.allocateRewards = function(blocks, callback){
        var workerRewards = {};
        var redisTx = _this.redisClient.multi();
        util.executeForEach(blocks, function(block, callback){
            allocateRewardForBlock(block, redisTx, workerRewards, callback);
        }, function(_){
            for (var worker in workerRewards){
                redisTx.hincrbyfloat(balancesKey, worker, workerRewards[worker]);
            }
            redisTx.exec(function(error, _){
                if (error) {
                    logger.error('Allocate rewards failed, error: ' + error);
                    callback(error);
                    return;
                }
                logger.debug('Rewards: ' + JSON.stringify(workerRewards));
                callback(null);
            });
        });
    }

    function allocateRewardForBlock(block, redisTx, workerRewards, callback){
        var blockData = block.data;
        var round = _this.roundKey(blockData.fromGroup, blockData.toGroup, blockData.hash);
        _this.redisClient.hgetall(round, function(error, shares){
            if (error) {
                logger.error('Get shares failed, error: ' + error + ', round: ' + round);
                callback();
                return;
            }

            var totalReward = Math.floor(parseInt(blockData.rewardAmount) * rewardPercent);
            logger.info('Reward miners for block: ' + blockData.hash + ', total reward: ' + totalReward);
            logger.debug('Block hash: ' + blockData.hash + ', shares: ' + JSON.stringify(shares));
            _this.allocateReward(totalReward, workerRewards, shares);

            redisTx.del(round);
            redisTx.srem(pendingBlocksKey, block.pendingBlockValue);
            logger.info('Remove shares for block: ' + blockData.hash);
            callback();
        });
    }

    this.allocateReward = function(totalReward, workerRewards, shares){
        var totalShare = Object.keys(shares).reduce(function(acc, worker){
            return acc + parseFloat(shares[worker]);
        }, 0);

        for (var worker in shares){
            var percent = parseFloat(shares[worker]) / totalShare;
            var workerReward = util.toALPH(totalReward * percent);
            if (workerRewards[worker]){
                workerRewards[worker] += workerReward;
            }
            else {
                workerRewards[worker] = workerReward;
            }
        }
    }

    function scanBlocks(){
        _this.redisClient.smembers(pendingBlocksKey, function(err, results){
            if (err){
                logger.error('Get pending blocks failed, error: ' + err);
                return;
            }
            _this.getPendingBlocks(results, function(blocks){
                _this.allocateRewards(blocks, _ => {});
            });
        })
    }

    this.start = function(){
        if (config.rewardEnabled){
            setInterval(scanBlocks, config.rewardInterval * 1000);
        }
    }
}
