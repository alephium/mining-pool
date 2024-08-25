const events = require('events');
const bignum = require('bignum');
const blockTemplate = require('./blockTemplate.js');
const constants = require('./constants.js');
const util = require('./util');
const crypto = require('crypto');

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
    InvalidBlockChainIndex: 26
};

function isStringType(value){
    return (typeof value === 'string') || (value instanceof String);
}

function MiningJobs(expiryDuration){
    var _this = this;

    this.jobsList = [];
    this.jobMap = {};

    this.removeExpiredJobs = function(now){
        while (now - _this.jobsList[0][0].timestamp > expiryDuration){
            var expiredJobs = _this.jobsList.shift();
            expiredJobs.forEach(job => delete _this.jobMap[job.jobId]);
        }
    }

    this.addJobs = function(jobs, now){
        _this.jobsList.push(jobs);
        _this.removeExpiredJobs(now);
        jobs.forEach(job => _this.jobMap[job.jobId] = job);
    }

    this.getJob = function(jobId){
        return _this.jobMap[jobId];
    }
}

/**
 * Emits:
 * - newJobs(jobs) - Use this event to broadcast new jobs
 * - share(shareData) - It will have blockHex if a block was found
**/
function JobManager(jobExpiryPeriod){

    //private members
    var _this = this;
    var jobCounter = new JobCounter();

    //public members
    this.validJobs = new MiningJobs(jobExpiryPeriod);

    this.processJobs = function(jobs){
        var now = Date.now();
        var jobIndex = crypto.randomInt(0, jobs.length)
        var job = jobs[jobIndex]
        job.jobId = jobCounter.next()
        var miningJobs = [new blockTemplate(job, now)]
        _this.validJobs.addJobs(miningJobs, now);
        _this.emit('newJobs', miningJobs);
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

    function addressIsValid(addressStr){
        var [_, error] = util.groupOfAddress(addressStr);
        return error == null;
    }

    this.getWorkerAddress = function(worker){
        if (!isStringType(worker)){
            return null;
        }

        var index = worker.indexOf('.');
        if (index === -1){
            return addressIsValid(worker) ? worker : null;
        }

        // try to decode address from prefix
        var address = worker.slice(0, index);
        if (addressIsValid(address)){
            var workerName = worker.slice(index + 1);
            return workerName.length > 32 ? null : address;
        }

        // try to decode address from postfix
        index = worker.lastIndexOf('.');
        address = worker.slice(index + 1);
        if (addressIsValid(address)){
            var workerName = worker.slice(0, index);
            return workerName.length > 32 ? null : address;
        }
        return null;
    }

    this.processShare = function(params, previousDifficulty, difficulty, remoteAddress, localPort){
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

        var job = _this.validJobs.getJob(params.jobId);
        if (typeof job === 'undefined' || job.jobId != params.jobId ) {
            return shareError([ErrorCodes.JobNotFound, 'job not found, maybe expired']);
        }

        if ((params.fromGroup != job.fromGroup) || (params.toGroup != job.toGroup)){
            return shareError([ErrorCodes.InvalidJobChainIndex, 'invalid job chain index']);
        }

        var address = _this.getWorkerAddress(params.worker);
        if (!address){
            return shareError([ErrorCodes.InvalidWorker, 'invalid worker']);
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
            workerAddress: address,
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
exports.MiningJobs = MiningJobs;
exports.JobCounter = JobCounter;
