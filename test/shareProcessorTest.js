const RedisMock = require('ioredis-mock');
const ShareProcessor = require('../lib/shareProcessor');
const winston = require('winston');
const { expect, assert } = require('chai');
const util = require('../lib/util');

var config = {
    "daemon": {
        "host": "127.0.0.1",
        "port": 12973,
        "apiKey": "0000000000000000000000000000000000000000000000000000000000000000",
        "minerApiPort": 10973
    },

    "redis": {
        "host": "127.0.0.1",
        "port": 6379
    },

    "withholdPercent": 0,
    "rewardInterval": 600,
    "confirmationTime": 30600,
};

var logger = winston.createLogger({
    transports: new winston.transports.Console({
        level: 'debug'
    })
});

describe('test share processor', function(){
    var redisClient;
    this.beforeEach(function(){
        redisClient = new RedisMock();
    })

    this.afterEach(function(){
        redisClient.disconnect();
    })

    it('should allocate reward according shares', function(){
        var shareProcessor = new ShareProcessor(config, logger);
        var workerRewards = {};
        var shares = {miner0: 8, miner1: 4, miner2: 2, miner3: 1, miner4: 1};
        var totalReward = util.fromALPH(16);
        shareProcessor.allocateReward(totalReward, workerRewards, shares);
        expect(workerRewards).to.deep.equal({
            miner0: 8, miner1: 4, miner2: 2, miner3: 1, miner4: 1
        })
    })

    it('should process shares', function(done){
        var shareProcessor = new ShareProcessor(config, logger);
        shareProcessor.redisClient = redisClient;

        var shareData = {
            job: {fromGroup: 0, toGroup: 1},
            worker: 'a',
            difficulty: 1.2,
            foundBlock: false
        };

        shareProcessor.handleShare(shareData);
        var currentRoundKey = shareProcessor.currentRoundKey(
            shareData.job.fromGroup,
            shareData.job.toGroup
        );

        redisClient.hget(currentRoundKey, shareData.worker, function(error, res){
            if (error) assert.fail('Test failed: ' + error);
            expect(parseFloat(res)).equal(shareData.difficulty);

            shareData.foundBlock = true;
            var blockHashHex = '0011';
            shareData.blockHash = Buffer.from(blockHashHex, 'hex');
            shareProcessor.handleShare(shareData);

            var roundKey = shareProcessor.roundKey(
                shareData.job.fromGroup,
                shareData.job.toGroup,
                blockHashHex
            );

            redisClient
                .multi()
                .hget(roundKey, shareData.worker)
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
                    expect(blockMiner).equal(shareData.worker);
                    done();
                });
        });
    })

    it('should update miner balances and remove shares', function(done){
        var shareProcessor = new ShareProcessor(config, logger);
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
})
