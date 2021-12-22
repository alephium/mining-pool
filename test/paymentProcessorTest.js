const RedisMock = require('ioredis-mock');
const { randomBytes } = require('crypto');
const { expect, assert } = require('chai');
const PaymentProcessor = require('../lib/paymentProcessor');
const util = require('../lib/util');
const test = require('./test');

describe('test payment processor', function(){
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
                balances: {
                    '1GQoT6oDKfi18m5JyCvKu9EBx4iiy6ie7cHw51NuF3idh': 4,
                    '1H59e6Sa2WwfsPqbobmRVGUBHdHAH7ux4c1bDx3LHMFiB': 4
                }
            },
            {
                group: '1',
                balances: {
                    '1FTkWfUJmERVYN6iV1jSNUkebQPS2g4xy4e3ETNB9N6Kg': 4
                }
            },
            {
                group: '3',
                balances: {
                    '1EK5p5d18z4skYB9VMNiuXYQHzF6MH5QqJ1uqQfJF2TFE': 4
                }
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

    function generateBalances(num, amount){
        var balances = [];
        while (balances.length < num){
            balances.push({
                address: randomHex(32),
                amount: amount.toString()
            });
        }
        return balances;
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

    var fromAddress = randomHex(32);
    var fromPublicKey = randomHex(64);

    it('should prepare transaction', function(){
        var utxos = generateUtxos(40, 3);
        var balances = generateBalances(30, 3.1);
        var payment = new PaymentProcessor(test.config, test.logger);

        var expected = expectedTxData(fromPublicKey, utxos.slice(0, 32), balances);
        var txsDatas = payment.prepareTransactions(fromAddress, fromPublicKey, utxos, balances);

        expect(txsDatas.length).equal(1);
        expect(txsDatas[0]).to.deep.equal(expected);
        expect(balances.length).equal(0);
    })

    it('should prepare multi transactions if there are too many miners', function(){
        var balances = generateBalances(138, 1);
        var utxos = generateUtxos(3, 150);
        var payment = new PaymentProcessor(test.config, test.logger);

        var expectedTx1 = expectedTxData(fromPublicKey, utxos.slice(0, 1), balances.slice(0, 136));
        var expectedTx2 = expectedTxData(fromPublicKey, utxos.slice(1, 2), balances.slice(136));
        var txsDatas = payment.prepareTransactions(fromAddress, fromPublicKey, utxos, balances);

        expect(txsDatas.length).equal(2);
        expect(expectedTx1).to.deep.equal(txsDatas[0]);
        expect(expectedTx2).to.deep.equal(txsDatas[1]);
        expect(balances.length).equal(0);
    })

    it('should failed prepare transaction if no enough balance', function(){
        var balances = generateBalances(10, 2);
        var utxos = generateUtxos(10, 1.1);
        var payment = new PaymentProcessor(test.config, test.logger);

        var expectedTx = expectedTxData(fromPublicKey, utxos.slice(0, 10), balances.slice(0, 5));
        var remainBalances = balances.slice(5);
        var txsDatas = payment.prepareTransactions(fromAddress, fromPublicKey, utxos, balances);

        expect(txsDatas.length).equal(1);
        expect(expectedTx).to.deep.equal(txsDatas[0]);
        expect(balances).to.deep.equal(remainBalances);
    })

    it('should failed prepare transaction if utxos is still locked', function(){
        var balances = generateBalances(10, 2);
        var utxos = generateUtxos(2, 15);
        utxos.forEach(utxo => utxo.lockTime = Date.now() + 1000);
        var payment = new PaymentProcessor(test.config, test.logger);

        var remainBalances = balances.slice(0);
        var txsDatas = payment.prepareTransactions(fromAddress, fromPublicKey, utxos, balances);

        expect(txsDatas.length).equal(0);
        expect(balances).to.deep.equal(remainBalances);
    })

    it('should update balances', function(done){
        var amount = 12, minus = 2;
        var balances = generateBalances(10, amount);
        var changedBalances = {};
        var remainBalances = {};
        var payment = new PaymentProcessor(test.config, test.logger);
        var redisClient = new RedisMock();
        payment.redisClient = redisClient;
        var redisTx = redisClient.multi();

        for (var idx in balances){
            var balance = balances[idx];
            redisTx.hincrbyfloat('balances', balance.address, parseFloat(balance.amount));
            changedBalances[balance.address] = minus;
            remainBalances[balance.address] = (amount - minus).toString();
        }

        var txId = randomHex(32);
        var checkBalances = function(){
            redisClient
                .multi()
                .smembers('transactions')
                .hgetall('balances')
                .exec(function(error, results){
                    if (error) assert.fail('Test error: ' + error);
                    var txs = results[0][1];
                    var remain = results[1][1];

                    expect(txs).to.deep.equal([txId]);
                    expect(remain).to.deep.equal(remainBalances);
                    redisClient.disconnect();
                    done();
                });
        }

        redisTx.exec(function(error, _){
            if (error) assert.fail('Test error: ' + error);
            payment.updateBalances(changedBalances, txId, _ => checkBalances());
        })
    })
})
