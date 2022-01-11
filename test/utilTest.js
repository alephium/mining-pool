const { expect } = require('chai');
const util = require('../lib/util');

it('should validate address', function(){
    var invalidAddress1 = '114E4tiwXSyfvCqLnARL21Ac2pVS6GvPomw5y6HsLMwuyR';
    var [addressGroup, error] = util.groupOfAddress(invalidAddress1);
    expect(addressGroup).equal(null);
    expect(error).equal('incorrect P2PKH address size');

    var invalidAddress2 = 'mJ81KDniPRnFddgY6gUqKP1QXh2j5n37M9JWzuyNYVUQ';
    var [addressGroup, error] = util.groupOfAddress(invalidAddress2);
    expect(addressGroup).equal(null);
    expect(error).equal('invalid P2PKH address');

    var invalidAddress3 = '    ';
    var [addressGroup, error] = util.groupOfAddress(invalidAddress3);
    expect(addressGroup).equal(null);
    expect(error).equal('invalid P2PKH address format');

    var validAddress = '1AqVGKeHWoLJiVU7heL8EvwQN2hk5bMtvP3PsH57qWayr';
    var [okey, error] = util.isValidAddress(validAddress, 2);
    expect(okey).equal(true);
    expect(error).equal(null);

    var [okey, error] = util.isValidAddress(validAddress, 1);
    expect(okey).equal(false);
})
