const events = require('events');
const bignum = require('bignum');
const blockTemplate = require('./blockTemplate.js');
const constants = require('./constants.js');
const util = require('./util');

//Unique job per new block template
var JobCounter = function(){
    var counter = 0;

    this.next = function(){
        counter++;
        if (counter % 0xffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};

var ErrorCodes = {
    JobNotFound: 20,
    InvalidJobChainIndex: 21,
    InvalidWorker: 22,
    InvalidNonce: 23,
    DuplicatedShare: 24,
    LowDifficulty: 25,
    JobExpired: 26,
    InvalidBlockChainIndex: 27
};

function isStringType(value){
    return (typeof value === 'string') || (value instanceof String);
}

/**
 * Emits:
 * - newJobs(jobs) - Use this event to broadcast new jobs
 * - share(shareData) - It will have blockHex if a block was found
**/
function JobManager(){

    //private members
    var _this = this;
    var jobCounter = new JobCounter();

    //public members
    this.currentJobs = [];
    this.validJobs = {};

    this.addJob = function(job, timestamp){
        var fromGroup = job.fromGroup;
        var toGroup = job.toGroup;
        var chainIndex = fromGroup * constants.GroupSize + toGroup;
        var jobId = jobCounter.next();
        job.jobId = jobId;
        var template = new blockTemplate(job, timestamp);
        this.currentJobs[chainIndex] = template;
        this.validJobs[jobId] = template;
    }

    this.processJobs = function(jobs){
        var now = Date.now();
        jobs.forEach(job => {
            this.addJob(job, now);
        });
        _this.emit('newJobs', this.currentJobs);
    };

    function validateNonce(nonceHex){
        if (!isStringType(nonceHex)){
            return null;
        }

        var nonce = null;
        try {
            nonce = Buffer.from(nonceHex, 'hex');
        } catch (error) {
            return null;
        }
        if (nonce.length === constants.NonceLength){
            return nonce;
        }
        return null;
    }

    this.processShare = function(params, previousDifficulty, difficulty, remoteAddress, localPort, expiryPeriod){
        var shareError = function(error){
            _this.emit('share', {
                job: params.jobId,
                ip: remoteAddress,
                worker: params.worker,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };

        var job = this.validJobs[params.jobId];

        if (typeof job === 'undefined' || job.jobId != params.jobId ) {
            return shareError([ErrorCodes.JobNotFound, 'job not found']);
        }

        var now = Date.now();
        if ((now - job.timestamp) > expiryPeriod){
            return shareError([ErrorCodes.JobExpired, 'job expired']);
        }

        if ((params.fromGroup != job.fromGroup) || (params.toGroup != job.toGroup)){
            return shareError([ErrorCodes.InvalidJobChainIndex, 'invalid job chain index']);
        }

        var nonce = validateNonce(params.nonce);
        if (!nonce) {
            return shareError([ErrorCodes.InvalidNonce, 'invalid nonce']);
        }

        if (!job.registerSubmit(params.nonce)) {
            return shareError([ErrorCodes.DuplicatedShare, 'duplicate share']);
        }

        var hash = job.hash(nonce);
        var [fromGroup, toGroup] = util.blockChainIndex(hash);
        if ((fromGroup != job.fromGroup) || (toGroup != job.toGroup)){
            return shareError([ErrorCodes.InvalidBlockChainIndex, 'invalid block chain index']);
        }

        var hashBigNum = bignum.fromBuffer(hash);

        var shareDiff = global.diff1Target.mul(1024).div(hashBigNum).toNumber() / 1024.0;
        var foundBlock = false;

        //Check if share is a block candidate (matched network difficulty)
        if (job.target.ge(hashBigNum)){
            foundBlock = true;
        }
        else {
            //Check if share didn't reached the miner's difficulty)
            if (shareDiff < difficulty){

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty){
                    difficulty = previousDifficulty;
                }
                else{
                    return shareError([ErrorCodes.LowDifficulty,
                        'low difficulty share of ' + shareDiff +
                        ', current difficulty: ' + difficulty +
                        ', previous difficulty: ' + previousDifficulty]
                    );
                }

            }
        }

        _this.emit('share', {
            job: job,
            nonce: nonce,
            ip: remoteAddress,
            port: localPort,
            worker: params.worker,
            difficulty: difficulty,
            shareDiff: shareDiff,
            blockHash: hash.toString('hex'),
            foundBlock: foundBlock
        });

        return {result: true, error: null, blockHash: hash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;

exports.JobManager = JobManager;
exports.ErrorCodes = ErrorCodes;
