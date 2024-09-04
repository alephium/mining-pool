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
    var now = Date.now() + (i * 60 * 1000)
    var job = { headerBlob: randomHeaderBlob(now) }
    var prevHeaderBlob = Buffer.from(job.headerBlob)

    updateJobTimestamp(job, now)
    expect(job.headerBlob).to.deep.equal(prevHeaderBlob)

    var newTs = now + (i * 60 * 1000)
    expect(newTs).not.equal(now)
    updateJobTimestamp(job, newTs)
    expect(job.headerBlob).to.not.deep.equal(prevHeaderBlob)

    prevHeaderBlob.writeBigUInt64BE(BigInt(newTs), prevHeaderBlob.length - 12)
    expect(job.headerBlob).to.deep.equal(prevHeaderBlob)
  }
})