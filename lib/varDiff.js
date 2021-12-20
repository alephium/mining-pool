const events = require('events');

/*
Vardiff ported from stratum-mining share-limiter
 https://github.com/ahmedbodi/stratum-mining/blob/master/mining/basic_share_limiter.py
 */

function RingBuffer(maxSize){
    var data = [];
    var cursor = 0;
    var isFull = false;
    this.append = function(x){
        if (isFull){
            data[cursor] = x;
            cursor = (cursor + 1) % maxSize;
        }
        else{
            data.push(x);
            cursor++;
            if (data.length === maxSize){
                cursor = 0;
                isFull = true;
            }
        }
    };
    this.avg = function(){
        var sum = data.reduce(function(a, b){ return a + b });
        return sum / (isFull ? maxSize : cursor);
    };
    this.size = function(){
        return isFull ? maxSize : cursor;
    };
    this.clear = function(){
        data = [];
        cursor = 0;
        isFull = false;
    };
}

// Truncate a number to a fixed amount of decimal places
function toFixed(num, len) {
    return parseFloat(num.toFixed(len));
}

var varDiff = module.exports = function varDiff(varDiffOptions){
    var _this = this;
    var bufferSize, tMin, tMax;
    var variance = varDiffOptions.targetTime * (varDiffOptions.variancePercent / 100);
    
    bufferSize = varDiffOptions.retargetTime / varDiffOptions.targetTime * 4;
    tMin       = varDiffOptions.targetTime - variance;
    tMax       = varDiffOptions.targetTime + variance;

    this.retarget = function(averageTargetTime, prevDifficulty){
        var ddiff = varDiffOptions.targetTime / averageTargetTime;

        if (averageTargetTime > tMax && prevDifficulty > varDiffOptions.minDiff){
            if (varDiffOptions.x2mode){
                ddiff = 0.5;
            }
            if (ddiff * prevDifficulty < varDiffOptions.minDiff){
                ddiff = varDiffOptions.minDiff / prevDifficulty;
            }
        } else if (averageTargetTime < tMin){
            if (varDiffOptions.x2mode){
                ddiff = 2;
            }
            if (ddiff * prevDifficulty > varDiffOptions.maxDiff){
                ddiff = varDiffOptions.maxDiff / prevDifficulty;
            }
        }
        else {
            return [false, prevDifficulty];
        }

        var newDifficulty = toFixed(prevDifficulty * ddiff, 8);
        return [true, newDifficulty];
    }

    this.manageClient = function(client){
        var options = varDiffOptions;
        var lastTs;
        var lastRtc;
        var timeBuffer;

        client.on('submit', function(){
            var ts = (Date.now() / 1000) | 0;
            if (!lastRtc){
                lastRtc = ts - options.retargetTime / 2;
                lastTs = ts;
                timeBuffer = new RingBuffer(bufferSize);
                return;
            }

            var sinceLast = ts - lastTs;
            timeBuffer.append(sinceLast);
            lastTs = ts;
            if ((ts - lastRtc) < options.retargetTime && timeBuffer.size() > 0)
                return;

            lastRtc = ts;
            var [diffUpdated, newDifficulty] = _this.retarget(timeBuffer.avg(), client.difficulty);
            if (diffUpdated){
                timeBuffer.clear();
                _this.emit('newDifficulty', client, newDifficulty);
            }
        });
    };
};
varDiff.prototype.__proto__ = events.EventEmitter.prototype;
