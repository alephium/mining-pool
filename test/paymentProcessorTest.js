const RedisMock = require('ioredis-mock');
const { randomBytes } = require('crypto');
const { expect, assert } = require('chai');
const nock = require('nock');
const PaymentProcessor = require('../lib/paymentProcessor');
const util = require('../lib/util');
const test = require('./test');

describe('test payment processor', function(){
    var redisClient;
    this.beforeEach(function(){
        redisClient = new RedisMock();
    })

    this.afterEach(function(){
        redisClient.disconnect();
    })

    it('should group miner balances by groupIndex', function(){
        var paymentProcessor = new PaymentProcessor(test.config, test.logger);
        var balances = {
            '1GQoT6oDKfi18m5JyCvKu9EBx4iiy6ie7cHw51NuF3idh': '4',  // groupIndex: 0
            '1H59e6Sa2WwfsPqbobmRVGUBHdHAH7ux4c1bDx3LHMFiB': '4',  // groupIndex: 0
            '1FTkWfUJmERVYN6iV1jSNUkebQPS2g4xy4e3ETNB9N6Kg': '4',  // groupIndex: 1
            '1EK5p5d18z4skYB9VMNiuXYQHzF6MH5QqJ1uqQfJF2TFE': '4',  // groupIndex: 3
            '1BncLrXD7fr9acVkETsxoNghyXLAXnxYSmLm8czVpSJ6u': '3'   // groupIndex: 3
        };
        var groupedBalances = paymentProcessor.grouping(balances);

        expect(groupedBalances).to.deep.equal([
            {
                group: '0',
                balances: [
                    {
                        address: '1GQoT6oDKfi18m5JyCvKu9EBx4iiy6ie7cHw51NuF3idh',
                        amount: 4
                    },
                    {
                        address: '1H59e6Sa2WwfsPqbobmRVGUBHdHAH7ux4c1bDx3LHMFiB',
                        amount: 4
                    }
                ]
            },
            {
                group: '1',
                balances: [
                    {
                        address:'1FTkWfUJmERVYN6iV1jSNUkebQPS2g4xy4e3ETNB9N6Kg',
                        amount: 4
                    }
                ]
            },
            {
                group: '3',
                balances: [
                    {
                        address: '1EK5p5d18z4skYB9VMNiuXYQHzF6MH5QqJ1uqQfJF2TFE',
                        amount: 4
                    }
                ]
            }
        ]);
    })

    function randomHex(size){
        return randomBytes(size).toString('hex');
    }

    function randomInt(){
        return Math.floor(Math.random() * Math.pow(2, 32));
    }

    function generateUtxos(num, amount){
        var utxos = [];
        while (utxos.length < num){
            utxos.push({
                ref: {key: randomHex(8), hint: randomInt()},
                amount: util.fromALPH(amount).toString(10),
                lockTime: Date.now() - 1000
            });
        }
        return utxos;
    }

    function generateBalances(num, amount, groupIndex){
        var balances = [];
        while (balances.length < num){
            balances.push({
                address: randomHex(32),
                amount: amount.toString()
            });
        }
        return {
            group: groupIndex ? groupIndex : 0,
            balances: balances
        };
    }

    function expectedTxData(fromPublicKey, utxos, balances){
        var inputNum = utxos.length;
        var outputNum = balances.length + 1; // change output
        var expectedGasAmount = 1000 + // txBaseGas
            inputNum * 2000 + // inputs gas
            outputNum * 4500 + // output gas
            2060; // p2pk unlock gas
        var expectedChangedBalances = {};
        for (var idx in balances){
            var balance = balances[idx];
            expectedChangedBalances[balance.address] = balance.amount;
        }
        var expectedInputs = utxos.map(utxo => utxo.ref);
        var expectedDestinations = balances.map(e => ({
            address: e.address,
            amount: util.fromALPH(e.amount).toString()
        }));
        return {
            fromPublicKey: fromPublicKey,
            gasAmount: Math.max(expectedGasAmount, 20000),
            inputs: expectedInputs,
            destinations: expectedDestinations,
            changedBalances: expectedChangedBalances
        }
    }

    var fromPublicKey = randomHex(64);

    it('should prepare transaction succeed', function(){
        var utxos = generateUtxos(40, 3);
        var balances = generateBalances(30, 3.1);
        var payment = new PaymentProcessor(test.config, test.logger);

        var expected = expectedTxData(fromPublicKey, utxos.slice(0, 32), balances.balances);
        var txsDatas = payment.prepareTransactions(fromPublicKey, utxos, [balances]);

        expect(txsDatas.length).equal(1);
        expect(txsDatas[0]).to.deep.equal(expected);
        expect(balances.balances.length).equal(0);
    })

    it('should prepare multi transactions if there are too many miners', function(){
        var balances = generateBalances(138, 1);
        var utxos = generateUtxos(3, 150);
        var payment = new PaymentProcessor(test.config, test.logger);

        var expectedTx1 = expectedTxData(fromPublicKey, utxos.slice(0, 1), balances.balances.slice(0, 136));
        var expectedTx2 = expectedTxData(fromPublicKey, utxos.slice(1, 2), balances.balances.slice(136));
        var txsDatas = payment.prepareTransactions(fromPublicKey, utxos, [balances]);

        expect(txsDatas.length).equal(2);
        expect(expectedTx1).to.deep.equal(txsDatas[0]);
        expect(expectedTx2).to.deep.equal(txsDatas[1]);
        expect(balances.balances.length).equal(0);
    })

    it('should prepare transactions failed if no enough utxos for transfer', function(){
        var balances = generateBalances(1, 10).balances;
        var utxos = generateUtxos(5, 1);
        var payment = new PaymentProcessor(test.config, test.logger);
        var txData = payment.prepareTransaction(fromPublicKey, utxos, balances);

        expect(txData.error).equal('not enough utxos for transfer, will try to transfer later');
        expect(utxos.length).equal(5);
        expect(balances.length).equal(1);
    })

    it('should prepare transactions failed if no enough utxos for tx fee', function(){
        var balances = generateBalances(1, 10).balances;
        var utxos = generateUtxos(5, 2);
        var payment = new PaymentProcessor(test.config, test.logger);
        var txData = payment.prepareTransaction(fromPublicKey, utxos, balances);

        expect(txData.error).equal('not enough utxos for tx fee, will try to transfer later');
        expect(utxos.length).equal(5);
        expect(balances.length).equal(1);
    })

    it('should prepare transactions failed if utxos is still locked', function(){
        var balances = generateBalances(10, 2);
        var utxos = generateUtxos(2, 15);
        utxos.forEach(utxo => utxo.lockTime = Date.now() + 1000);
        var payment = new PaymentProcessor(test.config, test.logger);

        var remainBalances = balances.balances.slice(0);
        var txsDatas = payment.prepareTransactions(fromPublicKey, utxos, [balances]);

        expect(txsDatas.length).equal(0);
        expect(balances.balances).to.deep.equal(remainBalances);
    })

    it('should prepare transactions for multiple groups', function(){
        var utxos = generateUtxos(10, 2);
        var group0 = generateBalances(1, 21, 0);
        var group1 = generateBalances(2, 4, 1);
        var payment = new PaymentProcessor(test.config, test.logger);
        var expectedTx = expectedTxData(fromPublicKey, utxos.slice(0, 5), group1.balances);
        var txsDatas = payment.prepareTransactions(fromPublicKey, utxos, [group0, group1]);

        expect(txsDatas.length).equal(1);
        expect(txsDatas[0]).to.deep.equal(expectedTx);
        expect(utxos.length).equal(5);
    })

    it('should estimate gas fee correctly', function(){
        var utxos = generateUtxos(10, 2);
        var group0 = generateBalances(1, 1, 0);
        var group1 = generateBalances(2, 4, 1);
        var payment = new PaymentProcessor(test.config, test.logger);
        var txsDatas = payment.prepareTransactions(fromPublicKey, utxos, [group0, group1]);

        expect(txsDatas.length).equal(2);
        expect(txsDatas[0].gasAmount).equal(20000);
        expect(txsDatas[1].gasAmount).equal(26560);
    })

    it('should lock rewards before submit tx', function(done){
        var payment = new PaymentProcessor(test.config, test.logger);
        payment.redisClient = redisClient;

        var txId = randomHex(32);
        nock('http://127.0.0.1:12973')
            .post('/transactions/submit', body => body.signature && body.unsignedTx)
            .reply(200, {txId: txId});

        var checkState = function(txId, remainBalances, lockedBalances){
            var lockedRewardsKey = payment.txRewardsKey(txId)
            redisClient
                .multi()
                .smembers('transactions')
                .hgetall('balances')
                .hgetall(lockedRewardsKey)
                .exec(function(error, results){
                    if (error) assert.fail('Test error: ' + error);
                    var txs = results[0][1];
                    var remain = results[1][1];
                    var lockedRewards = results[2][1];
                    Object.keys(lockedRewards).forEach(address => {
                        lockedRewards[address] = parseFloat(lockedRewards[address]);
                    });

                    expect(txs).to.deep.equal([txId]);
                    expect(remain).to.deep.equal(remainBalances);
                    expect(lockedRewards).to.deep.equal(lockedBalances);
                    done();
                });
        }

        var prepare = function(amount, changedAmount, callback){
            var initBalances = generateBalances(10, amount).balances;
            var changedBalances = {}, remainBalances = {};
            var redisTx = redisClient.multi();
            for (var idx in initBalances){
                var balance = initBalances[idx];
                redisTx.hincrbyfloat('balances', balance.address, parseFloat(balance.amount));
                changedBalances[balance.address] = changedAmount;
                remainBalances[balance.address] = (amount - changedAmount).toString();
            }

            redisTx.exec(function(error, _){
                if (error) assert.fail('Test error: ' + error);
                callback(changedBalances, remainBalances);
            });
        }

        prepare(12, 2, function(changedBalances, remainBalances){
            var signedTx = {
                txId: txId, unsignedTx: randomHex(12), signature: randomHex(12), changedBalances: changedBalances
            };

            payment.lockRewardsAndSubmitTx(signedTx, function(){
                checkState(txId, remainBalances, changedBalances);
            });
        })
    })

    it('should remove locked rewards when tx confirmed', function(done){
        var payment = new PaymentProcessor(test.config, test.logger);
        payment.redisClient = redisClient;

        var txId = randomHex(32);
        var lockRewardsKey = payment.txRewardsKey(txId);
        var prepare = function(amount, changedAmount, callback){
            var initBalances = generateBalances(10, amount).balances;
            var redisTx = redisClient.multi();
            redisTx.sadd('transactions', txId);
            for (var idx in initBalances){
                var balance = initBalances[idx];
                redisTx.hincrbyfloat('balances', balance.address, parseFloat(balance.amount));
                redisTx.hset(lockRewardsKey, balance.address, changedAmount);
            }

            redisTx.exec(function(error, _){
                if (error) assert.fail('Test error: ' + error);
                callback(initBalances);
            });
        }

        var checkState = function(expectedBalances){
            redisClient.multi()
                .smembers('transactions')
                .hgetall(lockRewardsKey)
                .hgetall('balances')
                .exec(function(error, results){
                    if (error) assert.fail('Test error: ' + error);
                    var txs = results[0][1];
                    var lockedRewards = results[1][1];
                    var balances = results[2][1];

                    expect(txs.length).equal(0);
                    expect(lockedRewards).to.deep.equal({});
                    expect(balances).to.deep.equal(expectedBalances);
                    done();
                })
        }

        prepare(12, 2, function(balances){
            var expectedBalances = {};
            for (var idx in balances){
                var balance = balances[idx];
                expectedBalances[balance.address] = balance.amount;
            }
            payment.onTxConfirmed(txId, _ => checkState(expectedBalances));
        });
    })

    it('should unlock rewards when tx failed', function(done){
        var payment = new PaymentProcessor(test.config, test.logger);
        payment.redisClient = redisClient;

        var txId = randomHex(32);
        var lockRewardsKey = payment.txRewardsKey(txId);
        var prepare = function(amount, changedAmount, callback){
            var initBalances = generateBalances(10, amount).balances;
            var unlockedBalances = {};
            var redisTx = redisClient.multi();
            redisTx.sadd('transactions', txId);
            for (var idx in initBalances){
                var balance = initBalances[idx];
                redisTx.hincrbyfloat('balances', balance.address, parseFloat(balance.amount));
                redisTx.hset(lockRewardsKey, balance.address, changedAmount);
                unlockedBalances[balance.address] = (amount + changedAmount).toString();
            }

            redisTx.exec(function(error, _){
                if (error) assert.fail('Test error: ' + error);
                callback(unlockedBalances);
            });
        }

        var checkState = function(expectedBalances){
            redisClient.multi()
                .smembers('transactions')
                .hgetall(lockRewardsKey)
                .hgetall('balances')
                .exec(function(error, results){
                    if (error) assert.fail('Test error: ' + error);
                    var txs = results[0][1];
                    var lockedRewards = results[1][1];
                    var balances = results[2][1];

                    expect(txs.length).equal(0);
                    expect(lockedRewards).to.deep.equal({});
                    expect(balances).to.deep.equal(expectedBalances);
                    done();
                })
        }

        prepare(12, 2, function(balances){
            payment.onTxFailed(txId, _ => checkState(balances));
        });
    })
})
