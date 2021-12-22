const RedisMock = require('ioredis-mock');
const Stats = require('../lib/stats');
const test = require('./test');
const { expect, assert } = require('chai');

describe('test stats', function(){
    it('should cleanup stale data after stats', function(done){
        var redisClient = new RedisMock();
        var stats = new Stats(test.config, test.logger);
        stats.redisClient = redisClient;

        var interval = 60;
        var currentMs = Date.now();
        var currentTs = Math.floor(Date.now() / 1000);
        var expiredTs = currentTs - 80;
        var from = currentTs - interval;
        var redisTx = redisClient.multi();

        for (var idx = 0; idx < 60; idx++){
            redisTx.zadd('hashrate', currentTs, [0, 0, 'miner' + idx, 1, currentMs].join(':'));
            redisTx.zadd('hashrate', expiredTs, [0, 1, 'miner' + idx, 1, currentMs].join(':'));
        }

        var checkState = function(){
            redisClient
                .multi()
                .zrangebyscore('hashrate', '-inf', '(' + from)
                .zrangebyscore('hashrate', from, '+inf')
                .exec(function(error, result){
                    if (result.error) assert.fail('Test error: ' + error);
                    expect(result[0][1].length).equal(0);
                    expect(result[1][1].length).equal(60);
                    done();
                });
        }

        redisTx.exec(function(error, _){
            if (error) assert.fail('Test error: ' + error);
            stats.getStats(interval, function(result){
                if (result.error) assert.fail('Test error: ' + error);
                var expectedHashRate = ((60 * Math.pow(2, test.config.diff1TargetNumZero)) / (interval * 1000 * 1000)).toFixed(2);
                expect(result.hashrate).equal(expectedHashRate);
                checkState();
            })
        });
    })
})
