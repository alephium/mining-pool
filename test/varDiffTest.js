const assert = require('assert');
const VarDiff = require('../lib/varDiff');

var varDiffOptions = {
    minDiff: 1,
    maxDiff: 4096,
    targetTime: 2.5,
    retargetTime: 90,
    variancePercent: 30
};

var varDiff = new VarDiff(varDiffOptions);

function validateDifficulty(newDifficulty, expected){
    var max = newDifficulty * 1.0000001;
    var min = newDifficulty * 0.9999999;
    assert(min <= expected && expected <= max);
}

function testAdjustDifficulty(prevDiffs, averageTargetTime){
    for (var prevDiff of prevDiffs){
        var [diffUpdated, newDiff] = varDiff.retarget(averageTargetTime, prevDiff);
        var expectedDiff = (prevDiff * (varDiffOptions.targetTime / averageTargetTime));
        assert(diffUpdated === true);
        validateDifficulty(newDiff, expectedDiff);
    }
}

describe('test var diff', function(){
    it('should decrease difficulty', function(){
        var prevDifficultys = [7, 10, 24.7, 111, 555];
        testAdjustDifficulty(prevDifficultys, 5.7);
    });

    it('should increase difficulty', function(){
        var prevDifficultys = [3.5, 10, 24.7, 111, 555];
        testAdjustDifficulty(prevDifficultys, 0.7);
    })

    it('should set difficulty to maximum', function(){
        var [diffUpdated, newDiff] = varDiff.retarget(1, 2048);
        assert(diffUpdated === true);
        validateDifficulty(newDiff, varDiffOptions.maxDiff);
    })

    it('should set difficulty to minimum', function(){
        var [diffUpdated, newDiff] = varDiff.retarget(6, 1.8);
        assert(diffUpdated === true);
        validateDifficulty(newDiff, varDiffOptions.minDiff);
    })

    it('should not adjust difficulty', function(){
        var [diffUpdated, _] = varDiff.retarget(3.1, 2.9);
        assert(diffUpdated === false);
    })
})
