const { Parser } = require("binary-parser");
const constants = require("./constants");

var headerSize = 4; // 4 bytes body length

var jobParser = new Parser()
    .endianess("big")
    .uint32('fromGroup')
    .uint32('toGroup')
    .uint32('headerBlobLength')
    .buffer('headerBlob', {
        'length': 'headerBlobLength'
    })
    .uint32('txsBlobLength')
    .buffer('txsBlob', {
        'length': 'txsBlobLength'
    })
    .uint32('targetLength')
    .buffer('targetBlob', {
        'length': 'targetLength'
    })
    .uint32('height')
    .saveOffset('dataLength');

exports.parseMessage = function(buffer, callback){
    if (buffer.length < headerSize) {
        callback(null, 0);
    }
    else {
        var bodyLength = buffer.readUInt32BE();
        if (buffer.length < (headerSize + bodyLength)) {
            callback(null, 0);
        }
        else {
            var version = buffer.readUInt8(headerSize); // 1 byte version
            if (version !== constants.MiningProtocolVersion) {
                throw Error(`Invalid protocol version ${version}, expect ${constants.MiningProtocolVersion}`);
            }
            var messageType = buffer.readUInt8(headerSize + 1); // 1 byte message type
            var startOffset = headerSize + 2;
            var endOffset = headerSize + bodyLength;
            var message = buffer.slice(startOffset, endOffset);
            var payload = parse(messageType, message);
            var result = {
                type: messageType,
                payload: payload
            };
            callback(result, endOffset);
        }
    }
}

function parse(messageType, buffer){
    if (messageType == constants.JobsMessageType) {
        return parseJobs(buffer);
    }
    else if (messageType == constants.SubmitResultMessageType) {
        return parseSubmitResult(buffer);
    }
    else {
        throw Error("Invalid message type"); // TODO: handle error properly
    }
}

function parseJobs(buffer){
    var jobSize = buffer.readUInt32BE();
    var offset = 4;
    var jobs = [];
    for (var index = 0; index < jobSize; index++){
        var job = jobParser.parse(buffer.slice(offset));
        jobs[index] = job;
        offset += job.dataLength;
    }
    return jobs;
}

function parseSubmitResult(buffer){
    var fromGroup = buffer.readUInt32BE();
    var toGroup = buffer.readUInt32BE(4);
    var blockHash = buffer.slice(8, 40)
    var result = buffer.readUInt8(40);
    var succeed = result == 1;
    return {
        fromGroup: fromGroup,
        toGroup: toGroup,
        blockHash: blockHash,
        succeed: succeed
    };
}

exports.updateJobTimestamp = function(job, newTimestamp) {
    var headerBlob = job.headerBlob
    var encodedTsLength = 8
    var encodedTargetLength = 4
    var tsOffset = job.headerBlob.length - (encodedTsLength + encodedTargetLength)
    headerBlob.writeBigUInt64BE(BigInt(newTimestamp), tsOffset)
}
