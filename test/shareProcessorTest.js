const RedisMock = require('ioredis-mock');
const { expect, assert } = require('chai');
const nock = require('nock');
const ShareProcessor = require('../lib/shareProcessor');
const util = require('../lib/util');
const test = require('./test');

describe('test share processor', function(){
    var redisClient;
    this.beforeEach(function(){
        redisClient = new RedisMock();
    })

    this.afterEach(function(){
        redisClient.disconnect();
    })

    it('should allocate reward according shares', function(){
        var shareProcessor = new ShareProcessor(test.config, test.logger);
        var workerRewards = {};
        var shares = {miner0: 8, miner1: 4, miner2: 2, miner3: 1, miner4: 1};
        var totalReward = util.fromALPH(16);
        shareProcessor.allocateReward(totalReward, workerRewards, shares);
        expect(workerRewards).to.deep.equal({
            miner0: 8, miner1: 4, miner2: 2, miner3: 1, miner4: 1
        })
    })

    it('should ignore duplicated shares', function(done){
        var shareProcessor = new ShareProcessor(test.config, test.logger);
        shareProcessor.redisClient = redisClient;

        var share1 = {job: {fromGroup: 0, toGroup: 1}, foundBlock: false, blockHash: 'hash1', difficulty: 1, workerAddress: 'miner1'};
        var share2 = {job: {fromGroup: 0, toGroup: 1}, foundBlock: false, blockHash: 'hash2', difficulty: 2, workerAddress: 'miner1'};
        var invalidShare = {job: {fromGroup: 0, toGroup: 1}, foundBlock: false, blockHash: 'hash1', difficulty: 3, workerAddress: 'miner1'};

        var checkState = function(cacheKey, roundKey, callback){
            redisClient
                .multi()
                .hget(roundKey, 'miner1')
                .smembers(cacheKey)
                .exec(function(error, results){
                    if (error) assert.fail('Test failed: ' + error);
                    var difficulty = results[0][1];
                    var shareHashes = results[1][1];
                    callback(difficulty, shareHashes);
                });
        };

        var cacheKey = shareProcessor.shareCacheKey(0, 1);
        var currentRoundKey = shareProcessor.currentRoundKey(0, 1);
        util.executeForEach([share1, share2, invalidShare], (share, callback) => {
            shareProcessor._handleShare(share, callback);
        }, function(){
            checkState(cacheKey, currentRoundKey, function(difficulty, shareHashes){
                expect(parseFloat(difficulty)).equal(share1.difficulty + share2.difficulty);
                expect(shareHashes).to.deep.equal([share1.blockHash, share2.blockHash]);

                var blockShare = {job: {fromGroup: 0, toGroup: 1}, foundBlock: true, blockHash: 'hash3', difficulty: 3, workerAddress: 'miner1'};
                shareProcessor._handleShare(blockShare, function(){
                    var roundKey = shareProcessor.roundKey(0, 1, blockShare.blockHash);
                    checkState(cacheKey, roundKey, function(difficulty, shareHashes){
                        expect(parseFloat(difficulty)).equal(share1.difficulty + share2.difficulty + blockShare.difficulty);
                        expect(shareHashes).to.deep.equal([]);
                        done();
                    });
                });
            });
        });
    })

    it('should process shares', function(done){
        var shareProcessor = new ShareProcessor(test.config, test.logger);
        shareProcessor.redisClient = redisClient;

        var shareData = {
            job: {fromGroup: 0, toGroup: 1},
            worker: 'proxy.1AqVGKeHWoLJiVU7heL8EvwQN2hk5bMtvP3PsH57qWayr',
            workerAddress: '1AqVGKeHWoLJiVU7heL8EvwQN2hk5bMtvP3PsH57qWayr',
            difficulty: 1.2,
            foundBlock: false
        };

        shareProcessor._handleShare(shareData, function(){

            var currentRoundKey = shareProcessor.currentRoundKey(
                shareData.job.fromGroup,
                shareData.job.toGroup
            );

            redisClient.hget(currentRoundKey, shareData.workerAddress, function(error, res){
                if (error) assert.fail('Test failed: ' + error);
                expect(parseFloat(res)).equal(shareData.difficulty);

                shareData.foundBlock = true;
                var blockHashHex = '0011';
                shareData.blockHash = blockHashHex;
                shareProcessor._handleShare(shareData, function(){

                    var roundKey = shareProcessor.roundKey(
                        shareData.job.fromGroup,
                        shareData.job.toGroup,
                        blockHashHex
                    );

                    redisClient
                        .multi()
                        .hget(roundKey, shareData.workerAddress)
                        .smembers('pendingBlocks')
                        .hget('foundBlocks', blockHashHex)
                        .exec(function(error, result){
                            if (error) assert.fail('Test failed: ' + error);
                            var difficulty = result[0][1];
                            var pendingBlocks = result[1][1];
                            var blockMiner = result[2][1];

                            expect(parseFloat(difficulty)).equal(shareData.difficulty * 2);
                            expect(pendingBlocks.length).equal(1);
                            expect(pendingBlocks[0].startsWith(blockHashHex));
                            expect(blockMiner).equal(shareData.workerAddress);
                            done();
                        });
                });
            });
        });
    })

    it('should update miner balances and remove shares', function(done){
        var shareProcessor = new ShareProcessor(test.config, test.logger);
        shareProcessor.redisClient = redisClient;

        var shares = {'miner0': '4', 'miner1': '2', 'miner2': '2'};
        var blockData = {hash: '0011', fromGroup: 0, toGroup: 1, height: 1, rewardAmount: '40000000000000000000'};
        var block = {pendingBlockValue: blockData.hash + ':' + '0', data: blockData};

        var checkState = function(){
            redisClient
                .multi()
                .hgetall('balances')
                .smembers('pendingBlocks')
                .exec(function(error, result){
                    if (error) assert.fail('Test failed: ' + error);
                    var balances = result[0][1];
                    var pendingBlocks = result[1][1];

                    expect(balances.miner0).equal('20');
                    expect(balances.miner1).equal('10');
                    expect(balances.miner2).equal('10');
                    expect(pendingBlocks.length).equal(0);
                    done();
                });
        }

        var roundKey = shareProcessor.roundKey(
            blockData.fromGroup,
            blockData.toGroup,
            blockData.hash
        );

        redisClient
            .multi()
            .sadd('pendingBlocks', block.pendingBlockValue)
            .hset(roundKey, 'miner0', shares.miner0)
            .hset(roundKey, 'miner1', shares.miner1)
            .hset(roundKey, 'miner2', shares.miner2)
            .exec(function(error, _){
                if (error) assert.fail('Test failed: ' + error);
                shareProcessor.allocateRewards([block], _ => checkState());
            });
    })

    it('should remove orphan block and shares', function(done){
        var shareProcessor = new ShareProcessor(test.config, test.logger);
        shareProcessor.redisClient = redisClient;

        var rewardAmount = '4000000000000000000';
        var transactions = [{outputs:[{amount: rewardAmount}]}];
        var currentMs = Date.now();
        var confirmationTime = test.config.confirmationTime * 1000;
        var blocks = [
            {hash: 'block1', height: 1, chainFrom: 0, chainTo: 0, transactions: transactions, inMainChain: true, submittedMs: currentMs},
            {hash: 'block2', height: 2, chainFrom: 0, chainTo: 0, transactions: transactions, inMainChain: false, submittedMs: currentMs - confirmationTime},
            {hash: 'block3', height: 3, chainFrom: 0, chainTo: 0, transactions: transactions, inMainChain: true, submittedMs: currentMs - confirmationTime},
            {hash: 'block4', height: 4, chainFrom: 0, chainTo: 0, transactions: transactions, inMainChain: true, submittedMs: currentMs - confirmationTime},
        ];

        var shares = {};
        for (var block of blocks){
            shares[block.hash] = {address: 'miner', difficulty: 1}
        }

        function prepare(blocks, shares, callback){
            var restServer = nock('http://127.0.0.1:12973');
            var redisTx = redisClient.multi();
            for (var block of blocks){
                restServer.get('/blockflow/blocks/' + block.hash).reply(200, block);
                var path = '/blockflow/is-block-in-main-chain?blockHash=' + block.hash;
                restServer.get(path).reply(200, block.inMainChain ? true : false);

                var blockWithTs = block.hash + ':' + block.submittedMs;
                redisTx.sadd('pendingBlocks', blockWithTs);
                var sharesOfBlock = shares[block.hash];
                var roundKey = shareProcessor.roundKey(block.chainFrom, block.chainTo, block.hash);
                for (var address in sharesOfBlock){
                    redisTx.hincrbyfloat(roundKey, address, sharesOfBlock[address]);
                }
            }

            redisTx.exec(function(error, _){
                if (error) assert.fail('Test failed: ' + error);
                callback(restServer);
            });
        }

        var blockData = function(block){
            return {hash: block.hash, fromGroup: block.chainFrom, toGroup: block.chainTo, height: block.height, rewardAmount: rewardAmount};
        }

        var checkState = function(){
            var orphanBlock = blocks[1];
            var orphanBlockWithTs = orphanBlock.hash + ':' + orphanBlock.submittedMs;
            var roundKey = shareProcessor.roundKey(orphanBlock.chainFrom, orphanBlock.chainTo, orphanBlock.hash);

            redisClient.multi()
                .smembers('pendingBlocks')
                .hgetall(roundKey)
                .exec(function(error, results){
                    if (error) assert.fail('Test failed: ' + error);

                    var pendingBlocks = results[0][1];
                    var orphanBlockShares = results[1][1];
                    expect(pendingBlocks.indexOf(orphanBlockWithTs)).equal(-1);
                    expect(orphanBlockShares).to.deep.equal({});
                    done();
                });
        }

        var runTest = function(_restServer){
            var expected = [
                {
                    pendingBlockValue: blocks[2].hash + ':' + blocks[2].submittedMs,
                    data: blockData(blocks[2])
                },
                {
                    pendingBlockValue: blocks[3].hash + ':' + blocks[3].submittedMs,
                    data: blockData(blocks[3])
                }
            ];

            shareProcessor.getPendingBlocks(
                blocks.map(block => block.hash + ':' + block.submittedMs),
                function(pendingBlocks){
                    expect(pendingBlocks).to.deep.equal(expected);
                    nock.cleanAll();
                    checkState();
                }
            );
        }

        prepare(blocks, shares, _restServer => runTest(_restServer));
    })
})
