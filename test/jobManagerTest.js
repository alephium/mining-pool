const JobManager = require('../lib/jobManager');
const bignum = require('bignum');
const { expect } = require('chai');

describe('test job manager', function(){
    global.diff1Target = bignum.pow(2, 228).sub(1);

    var job = {
        fromGroup: 1,
        toGroup: 2,
        headerBlob: Buffer.from('0007790e4ec67704f105b406379c6640a1edd9f4f55d07628fd555d72da436dccd50000000003309007511dbb1976d272fdaec0a5ead079da6e422c3c16faa593a3abddd3b822d4602064477d36478ce5a7370e0220e5daadfd9c4984f140a41537f000000005276b90956fa5c3d5b5cdb4235de493e239bd12523266099f0ae9834fd481a7288ec588c73287d61dc9b7ed326e1bc8980bffa383698fe780c1d00153b2890a5ea1c798f8e552c79e44d31fe1d02e2fbef8763369a774502229dd01600000000f07f98e3ec9b7d634293748bac9720310d681dd5a3e87f2f330d61d7c2f0ce1adccebc35c08b472d5d7f1a008009c8291382b839aa8493b57e58cbb400b9146184a084990fe481afb4fea6f0cdd5b372bce59d6be4b7c3b1a1ac72260000017ddbd15f591cffffff', 'hex'),
        txsBlob: Buffer.from('01000a0080004e20bb9aca000001c4261832f67ec288960022daf915864428873f422f045031a889ba81ecbd50db6e967c498b9d8af431e30000017ddbd33419000a01020000017ddbd15f590100000000', 'hex'),
        targetBlob: Buffer.from('00ffffff00000000000000000000000000000000000000000000000000', 'hex')
    };

    var nonce = 'ce5666fb5d8b65abfddd92bcb60f1f8852745ceb719454f8';
    var address = '1AqVGKeHWoLJiVU7heL8EvwQN2hk5bMtvP3PsH57qWayr';
    var invalidAddress = '114E4tiwXSyfvCqLnARL21Ac2pVS6GvPomw5y6HsLMwuyR';

    it('should add job', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);

        var chainIndex = job.fromGroup * 4 + job.toGroup;
        var jobId = job.jobId;
        var blockTemplate = jobManager.validJobs[jobId];
        expect(blockTemplate.headerBlob).equal(job.headerBlob);
        expect(blockTemplate.txsBlob).equal(job.txsBlob);
        expect(blockTemplate.targetBlob).equal(job.targetBlob);
        expect(blockTemplate).to.deep.equal(jobManager.currentJobs[chainIndex]);
    })

    it('should process share failed if job does not exist', function(){
        var jobManager = new JobManager();
        var params = {jobId: 1, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = jobManager.processShare(params, 2, 2, '127.0.0.1', 11111);
        var [errCode, errMsg] = result.error;
        expect(errCode).equal(20);
        expect(errMsg).equal('job not found');
    })

    it('should process share failed if chainIndex is invalid', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);
        var params = {jobId: job.jobId, fromGroup: job.fromGroup + 1, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = jobManager.processShare(params, 2, 2, '127.0.0.1', 11111);
        var [errCode, errMsg] = result.error;
        expect(errCode).equal(21);
        expect(errMsg).equal('invalid chain index');
    })

    it('should process share failed if miner address is invalid', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);
        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: invalidAddress};
        var result = jobManager.processShare(params, 2, 2, '127.0.0.1', 11111);
        var [errCode, errMsg] = result.error;
        expect(errCode).equal(22);
        expect(errMsg).equal('invalid worker address');
    })

    it('should process share failed if nonce is invalid', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);
        var invalidNonce = '0011';
        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: invalidNonce, worker: address};
        var result = jobManager.processShare(params, 2, 2, '127.0.0.1', 11111);
        var [errCode, errMsg] = result.error;
        expect(errCode).equal(23);
        expect(errMsg).equal('incorrect size of nonce');
    })

    it('should process share failed if share is duplicated', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);
        var blockTemplate = jobManager.validJobs[job.jobId];
        var result = blockTemplate.registerSubmit(nonce);
        expect(result).equal(true);

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var result = jobManager.processShare(params, 2, 2, '127.0.0.1', 11111);
        var [errCode, errMsg] = result.error;
        expect(errCode).equal(24);
        expect(errMsg).equal('duplicate share');
    })

    it('should process share failed if difficulty is low', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);
        var lowDiffNonce = '000000000000000000000000000000000000000000000000';

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: lowDiffNonce, worker: address};
        var result = jobManager.processShare(params, 2, 2, '127.0.0.1', 11111);
        var [errCode, _] = result.error;
        expect(errCode).equal(25);
    })

    it('should accept share if difficulty larger than current difficulty', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var currentDiff = 10;
        var prevDiff = 2;
        var result = jobManager.processShare(params, prevDiff, currentDiff, '127.0.0.1', 11111);
        expect(result.error).equal(null);

        jobManager.on('share', function(shareData){
            expect(shareData.difficulty).equal(currentDiff);
            expect(shareData.foundBlock).equal(true);
        });
    })

    it('should accept share if difficulty larger than previous difficulty', function(){
        var jobManager = new JobManager();
        jobManager.addJob(job);

        var params = {jobId: job.jobId, fromGroup: job.fromGroup, toGroup: job.toGroup, nonce: nonce, worker: address};
        var currentDiff = 20;
        var prevDiff = 10;
        var result = jobManager.processShare(params, prevDiff, currentDiff, '127.0.0.1', 11111);
        expect(result.error).equal(null);

        jobManager.on('share', function(shareData){
            expect(shareData.difficulty).equal(prevDiff);
            expect(shareData.foundBlock).equal(true);
        })
    })
})
