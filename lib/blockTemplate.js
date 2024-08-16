const bignum = require('bignum');
const blake3 = require('blake3')
const constants = require('./constants');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(job, timestamp){

    //private members

    var submits = [];
    var emptyTxsBlob = '';

    //public members

    this.jobId = job.jobId;
    this.timestamp = timestamp;
    this.fromGroup = job.fromGroup;
    this.toGroup = job.toGroup;
    this.headerBlob = job.headerBlob;
    this.txsBlob = job.txsBlob;
    this.targetBlob = job.targetBlob;
    this.target = bignum.fromBuffer(this.targetBlob);
    this.chainIndex = this.fromGroup * constants.GroupSize + this.toGroup;
    this.height = job.height

    this.registerSubmit = function(nonce){
        if (submits.indexOf(nonce) === -1){
            submits.push(nonce);
            return true;
        }
        return false;
    };

    this.hash = function(nonce){
        if (nonce.length != constants.NonceLength){
            throw new Error("Invalid nonce, size: " + nonce.length);
        }
        var header = Buffer.concat([nonce, this.headerBlob]);
        return blake3.hash(blake3.hash(header));
    }

    this.getJobParams = function(){
        if (!this.jobParams){
            this.jobParams = {
                jobId: this.jobId,
                fromGroup: this.fromGroup,
                toGroup: this.toGroup,
                headerBlob: this.headerBlob.toString('hex'),
                txsBlob: emptyTxsBlob,
                height: this.height
            };
        }
        return this.jobParams;
    };
};
