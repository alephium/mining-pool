const { JobManager, ErrorCodes } = require('../lib/jobManager');
const bignum = require('bignum');
const { expect } = require('chai');

describe('test job manager', function(){
    global.diff1Target = bignum.pow(2, 228).sub(1);

    var job = {
        fromGroup: 1,
        toGroup: 2,
        headerBlob: Buffer.from('0007790e4ec67704f105b406379c6640a1edd9f4f55d07628fd555d72da436dccd50000000003309007511dbb1976d272fdaec0a5ead079da6e422c3c16faa593a3abddd3b822d4602064477d36478ce5a7370e0220e5daadfd9c4984f140a41537f000000005276b90956fa5c3d5b5cdb4235de493e239bd12523266099f0ae9834fd481a7288ec588c73287d61dc9b7ed326e1bc8980bffa383698fe780c1d00153b2890a5ea1c798f8e552c79e44d31fe1d02e2fbef8763369a774502229dd01600000000f07f98e3ec9b7d634293748bac9720310d681dd5a3e87f2f330d61d7c2f0ce1adccebc35c08b472d5d7f1a008009c8291382b839aa8493b57e58cbb400b9146184a084990fe481afb4fea6f0cdd5b372bce59d6be4b7c3b1a1ac72260000017ddbd15f591cffffff', 'hex'),
        txsBlob: Buffer.from('01000a0080004e20bb9aca000001c4261832f67ec288960022daf915864428873f422f045031a889ba81ecbd50db6e967c498b9d8af431e30000017ddbd33419000a01020000017ddbd15f590100000000', 'hex'),
        targetBlob: Buffer.from('00ffffff00000000000000000000000000000000000000000000000000000000', 'hex')
    };

    var nonce = 'f8c8741232a4ebb0aad38ffb8e829b9bf5b00770f1ac31dc';
    var address = '1AqVGKeHWoLJiVU7heL8EvwQN2hk5bMtvP3PsH57qWayr';
    var invalidAddress = '114E4tiwXSyfvCqLnARL21Ac2pVS6GvPomw5y6HsLMwuyR';
    var defaultHost = '127.0.0.1';
    var defaultPort = 11111;
    var defaultExpiryPeriod = 500; // 500ms

    function processShare(jobManager, params, prevDiff, currDiff){
        return jobManager.processShare(params, prevDiff, currDiff, defaultHost, defaultPort, defaultExpiryPeriod);
    }

    it('should add job', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());

        var chainIndex = job.fromGroup * 4 + job.toGroup;
        var jobId = job.jobId;
        var blockTemplate = jobManager.validJobs[jobId];
        expect(blockTemplate.headerBlob).equal(job.headerBlob);
        expect(blockTemplate.txsBlob).equal(job.txsBlob);
        expect(blockTemplate.targetBlob).equal(job.targetBlob);
        expect(blockTemplate).to.deep.equal(jobManager.currentJobs[chainIndex]);
    })

    function expectError(error, code, msg){
        expect(error[0]).equal(code);
        expect(error[1]).equal(msg);
    }

    it('should process share failed if job does not exist', function(){
        var jobManager = new JobManager();
        var params = {jobId: 1, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = processShare(jobManager, params, 2, 2);
        expectError(result.error, ErrorCodes.JobNotFound, 'job not found');
    })

    it('should process share failed if job has expired', function(){
        var jobManager = new JobManager();
        var jobTs = Date.now() - defaultExpiryPeriod * 2;
        jobManager.addJob(job, jobTs);

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = processShare(jobManager, params, 2, 2);
        expectError(result.error, ErrorCodes.JobExpired, 'job expired');
    })

    it('should process share failed if chainIndex is invalid', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());
        var params = {jobId: job.jobId, fromGroup: job.fromGroup + 1, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = processShare(jobManager, params, 2, 2);
        expectError(result.error, ErrorCodes.InvalidJobChainIndex, 'invalid job chain index');
    })

    it('should process share failed if worker is invalid', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());
        var workers = [invalidAddress, 123, null, undefined, '.' + address + '.123', 'a'.repeat(33) + '.' + address];
        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce};
        for (var worker of workers){
            params.worker = worker;
            var result = processShare(jobManager, params, 2, 2);
            expectError(result.error, ErrorCodes.InvalidWorker, 'invalid worker');
        }
    })

    it('shuold process share succeed if worker is valid', function(){
        var workers = ['.' + address, address, 'abc.' + address, '....' + address];
        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce};
        for (var worker of workers){
            var jobManager = new JobManager();
            jobManager.addJob(job, Date.now());
            params.worker = worker;
            var result = processShare(jobManager, params, 2, 2);
            expect(result.error).equal(null);
        }
    })

    it('should process share failed if nonce is invalid', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());
        var nonces = ['0011', 123, null, undefined];
        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, worker: address};
        for (var nonce of nonces){
            params.nonce = nonce;
            var result = processShare(jobManager, params, 2, 2);
            expectError(result.error, ErrorCodes.InvalidNonce, 'invalid nonce');
        }
    })

    it('should process share failed if share is duplicated', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());
        var blockTemplate = jobManager.validJobs[job.jobId];
        var result = blockTemplate.registerSubmit(nonce);
        expect(result).equal(true);

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = processShare(jobManager, params, 2, 2);
        expectError(result.error, ErrorCodes.DuplicatedShare, 'duplicate share');
    })

    it('should process share failed if difficulty is low', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());
        var lowDiffNonce = '301d0b1f7e61e1d532d37df520f1acc92cfccc48de323e1c';

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: lowDiffNonce, worker: address};
        var result = processShare(jobManager, params, 2, 2);
        var [errCode, _] = result.error;
        expect(errCode).equal(ErrorCodes.LowDifficulty);
    })

    it('should process share failed if chain index unmatched', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());
        var invalidNonce = 'b6414be3a40e1a2852b3171e4462846ea48c777104b03e5e';

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: invalidNonce, worker: address};
        var result = processShare(jobManager, params, 2, 2);
        expect(result.error, ErrorCodes.InvalidBlockChainIndex, 'invalid block chain index');
    })

    it('should accept share if difficulty larger than current difficulty', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var currentDiff = 10;
        var prevDiff = 2;
        var result = processShare(jobManager, params, prevDiff, currentDiff);
        expect(result.error).equal(null);

        jobManager.on('share', function(shareData){
            expect(shareData.difficulty).equal(currentDiff);
            expect(shareData.foundBlock).equal(true);
        });
    })

    it('should accept share if difficulty larger than previous difficulty', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job, Date.now());

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var currentDiff = 20;
        var prevDiff = 10;
        var result = processShare(jobManager, params, prevDiff, currentDiff);
        expect(result.error).equal(null);

        jobManager.on('share', function(shareData){
            expect(shareData.difficulty).equal(prevDiff);
            expect(shareData.foundBlock).equal(true);
        })
    })
})
