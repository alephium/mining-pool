const { expect } = require('chai');
const { randomBytes } = require('crypto');
const constants = require('../lib/constants');
const { updateJobTimestamp } = require("../lib/messages")

it('should update the job timestamp', function(){
  function randomHeaderBlob(ts) {
    var encodedTs = Buffer.alloc(8)
    encodedTs.writeBigUInt64BE(BigInt(ts))
    return Buffer.concat([
      randomBytes(24), // nonce
      randomBytes(1), // version
      randomBytes(1 + (2 * constants.GroupSize - 1) * 32), // block deps
      randomBytes(32), // state hash
      randomBytes(32), // txs hash
      encodedTs,
      randomBytes(4), // target
    ])
  }

  for (var i = 1; i <= 10; i += 1) {
    var jobTs = Date.now() + (i * 60 * 1000)
    var job = { headerBlob: randomHeaderBlob(jobTs) }
    var prevHeaderBlob = Buffer.from(job.headerBlob)

    updateJobTimestamp(job, _ => jobTs)
    expect(job.headerBlob).to.deep.equal(prevHeaderBlob)

    var delta = i * 60 * 1000
    updateJobTimestamp(job, ts => ts + delta)
    expect(job.headerBlob).to.not.deep.equal(prevHeaderBlob)

    var tsOffset = job.headerBlob.length - 12
    prevHeaderBlob.writeBigUInt64BE(BigInt(jobTs + delta), tsOffset)
    expect(job.headerBlob).to.deep.equal(prevHeaderBlob)
    expect(Number(job.headerBlob.readBigUInt64BE(tsOffset))).to.equal(jobTs + delta)
  }
})