const Redis = require('ioredis');

var Stats = module.exports = function(config, logger){
    var hashrateKey = "hashrate";
    var hashrateEventsKey = "hashrate-events";
    var _this = this;
    this.redisClient = new Redis(config.redis.port, config.redis.host);

    function calcHashrate(interval, callback){
        var now = Math.floor(Date.now() / 1000);
        var from = now - interval;

        _this.redisClient
            .multi()
            .zrangebyscore(hashrateKey, from, '+inf')
            .zremrangebyscore(hashrateKey, '-inf', '(' + from)
            .exec(function(error, results){
                if (error){
                    logger.error('Get hashrate data failed, error: ' + error);
                    callback({error: error});
                    return;
                }

                var hashrateData = results[0][1];
                var difficultySum = 0;
                for (var idx in hashrateData){
                    // data format: 'fromGroup:toGroup:worker:difficulty:ms'
                    var data = hashrateData[idx].split(':');
                    difficultySum += parseFloat(data[3]);
                }
                // multiply 16 because we encoded the chainIndex to blockHash
                var hashrate = difficultySum * 16 * Math.pow(2, config.diff1TargetNumZero) / interval;
                callback({hashrate: (hashrate / 1000000).toFixed(2)});
            });
    }

    this.getStats = function(interval, callback){
        calcHashrate(interval, callback);
    }

    this.reportStatsRegularly = function(){
        setInterval(function(){
            _this.getStats(config.statsInterval, function(result){
                if (result.error){
                    logger.error('Stats failed, error: ' + result.error);
                    return;
                }
                _this.redisClient.publish(hashrateEventsKey, result.hashrate)
                logger.info('Pool hashrate: ' + result.hashrate + ' MH/s');
            })
        }, config.statsInterval * 1000);
    }
}
