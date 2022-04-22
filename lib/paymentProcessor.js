const Redis = require('ioredis');
const HttpClient = require('./httpClient');
const util = require('./util');
const constants = require('./constants');

var PaymentProcessor = module.exports = function PaymentProcessor(config, logger){
    var balancesKey = "balances";
    var transactionsKey = "transactions";
    var addressGroupCache = {};
    var minPaymentCoins = parseFloat(config.minPaymentCoins);

    // gas constants
    const maxGasPerTx = 625000;
    const minimumGas = 20000;
    const gasPerInput = 2000;
    const gasPerOutput = 4500;
    const txBaseGas = 1000;
    const p2pkUnlockGas = 2060;
    const defaultGasFee = 100000000000;

    var _this = this;
    this.addressInfo = [];
    this.redisClient = new Redis(config.redis.port, config.redis.host, {db: config.redis.db});
    this.httpClient = new HttpClient(config.daemon.host, config.daemon.port, config.daemon.apiKey);

    function getUtxoForTransfer(utxos, amount, now){
        var sum = 0;
        var selected = [];
        while (utxos.length > 0){
            if (sum >= amount){
                break;
            }

            var utxoData = utxos.shift();
            if (utxoData.lockTime <= now){
                var utxoAmount = parseInt(utxoData.amount);
                sum += utxoAmount;
                selected.push(utxoData);
            }
        }
        if (sum >= amount){
            return {sum: sum, selected: selected};
        }
        return {error: "not enough balance", sum: sum, selected: selected};
    }

    this.prepareTransaction = function(fromPublicKey, utxos, balances){
        var txInputs = [], txDestinations = [], changedBalances = {};
        var now = Date.now(), inputSum = 0, outputSum = 0;
        var estimatedGas = txBaseGas + p2pkUnlockGas + gasPerOutput; // change output

        var addDestination = function(output){
            var amount = util.fromALPH(output.amount);
            outputSum += amount;
            txDestinations.push({address: output.address, amount: amount});
            changedBalances[output.address] = output.amount;
            estimatedGas += gasPerOutput
        }

        var popDestination = function(){
            var destination = txDestinations.pop();
            outputSum -= destination.amount;
            var address = destination.address;
            balances.unshift({address: address, amount: changedBalances[address]});
            delete changedBalances[address];
            estimatedGas -= gasPerOutput;
        }

        var addInputs = function(selected, selectedSum){
            txInputs.push(selected);
            estimatedGas += selected.length * gasPerInput;
            inputSum += selectedSum;
        }

        var popInputs = function(selectedSum){
            var selected = txInputs.pop();
            estimatedGas -= selected.length * gasPerInput;
            selected.forEach(output => utxos.push(output));
            inputSum -= selectedSum;
        }

        var calcTxFee = function(){
            var txGas = Math.max(minimumGas, estimatedGas);
            return txGas * defaultGasFee;
        }

        // pay as many miners as possible in one tx
        while (balances.length > 0){
            addDestination(balances.shift());
            if (estimatedGas > maxGasPerTx){
                popDestination();
                break;
            }
            if (outputSum < inputSum){
                continue;
            }

            var result = getUtxoForTransfer(utxos, outputSum - inputSum, now);
            if (result.error){
                result.selected.forEach(output => utxos.push(output));
                popDestination();
                break;
            }
            addInputs(result.selected, result.sum);
            if (estimatedGas > maxGasPerTx){
                popInputs(result.sum);
                popDestination();
                break;
            }
        }

        if (txInputs.length === 0){
            return {error: 'not enough utxos for transfer, will try to transfer later'};
        }

        var txFee = calcTxFee();
        var remain = inputSum - outputSum;
        var popDestinations = function(){
            while (remain < txFee && txDestinations.length > 0){
                popDestination();
                remain = inputSum - outputSum;
                txFee = calcTxFee();
            }
        }

        var txData = function(){
            if (txDestinations.length === 0){
                txInputs.forEach(selected => selected.forEach(output => utxos.push(output)));
                return {error: 'not enough utxos for tx fee, will try to transfer later'};
            } else return {
                fromPublicKey: fromPublicKey,
                gasAmount: Math.max(minimumGas, estimatedGas),
                inputs: txInputs.flat().map(output => output.ref),
                destinations: txDestinations.map(e => ({address: e.address, alphAmount: e.amount.toString()})),
                changedBalances: changedBalances
            }
        }

        if (remain >= txFee){
            return txData();
        }

        // try to cover the tx fee
        var result = getUtxoForTransfer(utxos, txFee - remain, now);
        if (result.error){
            result.selected.forEach(output => utxos.push(output));
            // try to remove destinations if not enough utxos
            popDestinations()
            return txData();
        }

        addInputs(result.selected, result.sum);
        if (estimatedGas > maxGasPerTx){
            popInputs(result.sum);
            // try to remove destinations if gas larger than `maxGasPerTx`, this should rarely happen
            popDestinations()
            return txData();
        }
        return txData();
    }

    this.prepareTransactions = function(fromPublicKey, utxos, groupedBalances){
        var txsData = [];
        logger.debug('Payment data: ' + JSON.stringify({utxos: utxos, groupedBalances: groupedBalances}));
        for (var idx in groupedBalances){
            var entry = groupedBalances[idx];
            var groupIndex = entry.group;
            var balances = entry.balances;
            while (balances.length > 0 && utxos.length > 0){
                var result = this.prepareTransaction(fromPublicKey, utxos, balances);
                if (result.error){
                    logger.error('Prepare transaction error: ' + result.error +
                        ', group: ' + groupIndex +
                        ', remain balances: ' + JSON.stringify(balances)
                    );
                    break;
                }
                txsData.push(result);
            }
        }
        logger.debug('Prepared txs: ' + JSON.stringify(txsData));
        return txsData;
    }

    function transfer(addressInfo, groupedBalances, callback){
        var fromAddress = addressInfo.address;
        var fromPublicKey = addressInfo.publicKey;

        _this.httpClient.getUtxos(fromAddress, function(result){
            if (result.error){
                logger.error('Get utxos failed, error: ' + result.error + ', fromAddress: ' + fromAddress);
                callback();
                return;
            }

            var utxoIsEnough = haveEnoughUtxo(result.utxos, groupedBalances);
            if (!utxoIsEnough) logger.warn('Not enough utxo when transfer');
            var txsData = _this.prepareTransactions(fromPublicKey, result.utxos, groupedBalances);
            prepareSendTxs(fromAddress, function(error){
                if (error){
                    callback();
                    return;
                }
                util.executeForEach(
                    txsData,
                    (txData, callback) => sendTx(fromAddress, txData, callback),
                    _ => {
                        var remains = groupedBalances.filter(e => e.balances.length > 0);
                        if ((remains.length > 0) && utxoIsEnough){
                            logger.debug("Transfer remain balances: " + JSON.stringify(remains));
                            transfer(addressInfo, remains, callback);
                            return;
                        }
                        callback();
                    }
                );
            });
        });
    }

    function haveEnoughUtxo(utxos, groupedBalances){
        var inputSum = 0, outputSum = 0;
        for (var utxo of utxos){
            inputSum += parseInt(utxo.amount);
        }
        for (var entry of groupedBalances){
            outputSum += entry.balances.map(e => e.amount).reduce((a, b) => a + b, 0);
        }
        return util.toALPH(inputSum) > outputSum;
    }

    function prepareSendTxs(fromAddress, callback){
        _this.httpClient.unlockWallet(
            config.wallet.name,
            config.wallet.password,
            config.wallet.mnemonicPassphrase,
            function(result){
                if (result.error){
                    logger.error('Unlock wallet ' + config.wallet.name + ' failed, error: ' + result.error);
                    callback(result.error);
                    return;
                }

                _this.httpClient.changeActiveAddress(
                    config.wallet.name,
                    fromAddress,
                    function(result){
                        if (result.error){
                            logger.error('Change active address failed, error: ' + result.error + ', address: ' + fromAddress);
                            callback(result.error);
                            return;
                        }
                        callback(null);
                    }
                )
            }
        );
    }

    function sendTx(fromAddress, txData, callback){
        var handleUnsignedTx = function(unsignedTx){
            if (unsignedTx.error){
                logger.error('Build unsigned tx failed, error: ' + unsignedTx.error +
                    ', fromAddress: ' + fromAddress +
                    ', destinations: ' + JSON.stringify(txData.destinations) +
                    ', inputs: ' + JSON.stringify(txData.inputs) +
                    ', gas: ' + JSON.stringify(txData.gasAmount)
                );
                callback();
                return;
            }

            _this.httpClient.signTx(config.wallet.name, unsignedTx.txId, function(result){
                if (result.error){
                    logger.error('Sign tx failed, error: ' + result.error +
                        ', fromAddress: ' + fromAddress +
                        ', txId: ' + unsignedTx.txId
                    );
                    callback();
                    return;
                }

                var signedTx = {
                    txId: unsignedTx.txId,
                    changedBalances: txData.changedBalances,
                    signature: result.signature,
                    unsignedTx: unsignedTx.unsignedTx
                };
                _this.lockRewardsAndSubmitTx(signedTx, _ => callback());
            });
        }

        _this.httpClient.buildUnsignedTxFromUtxos(
            txData.fromPublicKey,
            txData.destinations,
            txData.inputs,
            txData.gasAmount,
            handleUnsignedTx
        );
    }

    this.txRewardsKey = function(txId){
        return 'rewards:' + txId;
    }

    this.lockRewards = function(txId, changedBalances, callback){
        var redisTx = _this.redisClient.multi();
        var lockedRewardsKey = _this.txRewardsKey(txId);
        redisTx.sadd(transactionsKey, txId);
        for (var address in changedBalances){
            var amount = changedBalances[address];
            redisTx.hincrbyfloat(balancesKey, address, -amount);
            redisTx.hset(lockedRewardsKey, address, amount);
        }

        redisTx.exec(function(error, _){
            if (error){
                logger.error('Lock rewards failed, error: ' + error);
                callback(error);
                return;
            }
            callback(null);
        });
    }

    this.lockRewardsAndSubmitTx = function(signedTx, callback){
        _this.lockRewards(signedTx.txId, signedTx.changedBalances, function(error){
            if (error){
                callback(error);
                return;
            }
            _this.httpClient.submitTx(
                signedTx.unsignedTx,
                signedTx.signature,
                function(result){
                    if (result.error){
                        logger.error('Submit tx failed, error: ' + result.error + ', txId: ' + signedTx.txId);
                        callback(result.error);
                        return;
                    }
                    logger.info('Tx ' + result.txId + ' submitted');
                    callback(null);
                }
            );
        });
    }

    this.checkTxConfirmation = function(txId, confirmations, onTxConfirmed, onTxFailed, callback){
        _this.httpClient.txStatus(txId, function(result){
            if (result.error){
                logger.error('Check tx status failed, error: ' + error);
                callback();
                return;
            }

            switch(result.type){
                case 'Confirmed':
                    if ((result.chainConfirmations >= confirmations.chainConfirmations) &&
                        (result.fromGroupConfirmations >= confirmations.fromGroupConfirmations) &&
                        (result.toGroupConfirmations >= confirmations.toGroupConfirmations)
                    ){
                        logger.info('Tx ' + txId + ' confirmed');
                        onTxConfirmed(txId, callback);
                        return;
                    }
                    logger.info('Tx ' + txId + ' confirmations is not enough');
                    callback();
                    break;
                case 'MemPooled':
                    logger.info('Tx ' + txId + ' is mem-pooled');
                    callback();
                    break;
                case 'TxNotFound':
                    logger.info('Tx ' + txId + ' not found');
                    onTxFailed(txId, callback);
                    break;
                default:
                    logger.error('Unknown tx status: ' + result.type);
                    callback();
                    break;
            }
        });
    }

    this.checkTxConfirmations = function(callback){
        _this.redisClient.smembers(transactionsKey, function(error, txIds){
            if (error){
                logger.error('Get transactions failed, error: ' + error);
                callback();
                return;
            }
            util.executeForEach(
                txIds,
                (txId, callback) => _this.checkTxConfirmation(txId, config.txConfirmations, _this.onTxConfirmed, _this.onTxFailed, callback),
                _ => callback()
            );
        });
    }

    this.onTxFailed = function(txId, callback){
        var lockedRewardsKey = _this.txRewardsKey(txId);
        _this.redisClient.hgetall(lockedRewardsKey, function(error, balances){
            if (error){
                logger.error('Get locked rewards failed, error: ' + error);
                callback();
                return;
            }

            var redisTx = _this.redisClient.multi();
            redisTx.srem(transactionsKey, txId);
            redisTx.del(lockedRewardsKey);
            for (var address in balances){
                var amount = parseFloat(balances[address]);
                redisTx.hincrbyfloat(balancesKey, address, amount);
            }

            redisTx.exec(function(error, _){
                if (error){
                    logger.error('Update state failed when tx failed, error: ' + error);
                }
                callback();
            });
        });
    }

    this.onTxConfirmed = function(txId, callback){
        var redisTx = _this.redisClient.multi();
        redisTx.del(_this.txRewardsKey(txId));
        redisTx.srem(transactionsKey, txId);
        redisTx.exec(function(error, _){
            if (error){
                logger.error('Update state failed when tx confirmed, error: ' + error);
            }
            callback();
        });
    }

    this.grouping = function(allBalances){
        // we have 4 groups
        var groups = [[], [], [], []];
        for (var address in allBalances){
            var balance = parseFloat(allBalances[address]);
            if (balance >= minPaymentCoins){
                var groupIndex = addressGroupCache[address];
                if (!groupIndex){
                    var [addressGroup, error] = util.groupOfAddress(address);
                    if (error){
                        logger.error('Invalid address: ' + address + ', error: ' + error);
                        continue;
                    }
                    groupIndex = addressGroup;
                    addressGroupCache[address] = groupIndex;
                }
                var group = groups[groupIndex];
                group.push({address: address, amount: balance});
            }
        }
        var groupBalances = [];
        for (var idx in groups){
            if (Object.keys(groups[idx]).length > 0){
                groupBalances.push({
                    group: idx,
                    balances: groups[idx]
                });
            }
        }
        return groupBalances;
    }

    function sweepToAddress(toAddress, fromAddress, callback){
        prepareSendTxs(fromAddress, function(error){
            if (error){
                callback({error: error});
                return;
            }

            _this.httpClient.sweepActiveAddress(
                config.wallet.name,
                toAddress,
                function(result){
                    if (result.error){
                        logger.error('Sweep failed, error: ' + result.error +
                            ', fromAddress: ' + fromAddress,
                            ', toAddress: ' + toAddress
                        );
                        callback({error: result.error});
                        return;
                    }

                    callback(result);
                }
            );
        });
    }

    function sweep(fromAddresses, toAddress, callback){
        var txs = [];
        util.executeForEach(fromAddresses,
            function(fromAddress, callback){
                sweepToAddress(toAddress, fromAddress, function(result){
                    if (result.error){
                        callback();
                        return;
                    }

                    for (var entry of result.results){
                        txs.push(entry);
                    }
                    callback();
                });
            },
            _ => {
                logger.debug('Sweep completed, txs: ' + JSON.stringify(txs));
                _this.waitSweepTxsConfirmed(txs.map(txInfo => txInfo.txId), callback);
            }
        );
    }

    this.waitSweepTxsConfirmed = function(txs, callback){
        var confirmations = {
            chainConfirmations: 1,
            fromGroupConfirmations: 1,
            toGroupConfirmations: 1
        };
        var checkConfirmed = function(txs, callback){
            var unconfirmedTxs = txs.slice();
            util.executeForEach(
                txs,
                (txId, callback) => _this.checkTxConfirmation(
                    txId,
                    confirmations,
                    (txId, callback) => {
                        unconfirmedTxs = unconfirmedTxs.filter(id => id !== txId);
                        callback();
                    },
                    (txId, _) => {
                        logger.error('Sweep tx failed, txId: ' + txId);
                        setTimeout(payment, config.paymentInterval * 1000);
                    },
                    callback
                ),
                _ => {
                    if (unconfirmedTxs.length > 0){
                        setTimeout(_ => checkConfirmed(unconfirmedTxs, callback), 30 * 1000);
                        return;
                    }
                    logger.debug('Sweep txs are confirmed');
                    callback();
                }
            );
        };

        setTimeout(_ => checkConfirmed(txs, callback), 30 * 1000);
    }

    function payment(){
        _this.checkTxConfirmations(function(){
            _this.redisClient.hgetall(balancesKey, function(error, result){
                if (error){
                    logger.error('Get balances error: ' + error);
                    return;
                }

                logger.info('Payment loop started');
                var index = Math.floor(Math.random() * 4);
                var toAddress = config.addresses[index];
                var fromAddresses = config.addresses.filter(addr => addr !== toAddress);
                var addressInfo = _this.addressInfo[index];
                var groupedBalances = _this.grouping(result);
                sweep(fromAddresses, toAddress, function(){
                    transfer(addressInfo, groupedBalances, _ => {
                        logger.info('Payment loop completed');
                        setTimeout(payment, config.paymentInterval * 1000);
                    });
                });
            });
        });
    }

    this.start = function(){
        if (config.paymentEnabled){
            checkAddress(config.addresses);
            loadPublicKey(config.wallet, function(){
                setTimeout(payment, config.paymentInterval * 1000);
            });
        }
    }

    function loadPublicKey(walletConfig, callback){
        var walletName = walletConfig.name;
        var password = walletConfig.password;
        var mnemonicPassphrase = walletConfig.mnemonicPassphrase;
        _this.httpClient.unlockWallet(walletName, password, mnemonicPassphrase, function(result){
            if (result.error){
                logger.error('Load public key, unlock wallet failed, error: ' + result.error);
                process.exit(1);
            }

            util.executeForEach(
                config.addresses.slice(),
                function(address, callback){
                    _this.httpClient.getAddressInfo(walletName, address, function(result){
                        if (result.error){
                            logger.error('Load public key, get address info failed, error: ' + result.error);
                            process.exit(1);
                        }

                        _this.addressInfo.push({
                            address: address,
                            publicKey: result.publicKey
                        });
                        callback();
                    });
                },
                _ => callback()
            );
        });
    }

    function checkAddress(addresses){
        if (addresses.length != constants.GroupSize){
            logger.error('Expect ' + constants.GroupSize + ' miner addresses, but have ' + addresses.length);
            process.exit(1);
        }

        for (var idx = 0; idx < constants.GroupSize; idx++){
            var [okey, error] = util.isValidAddress(addresses[idx], idx);
            if (error || !okey){
                logger.error('Invalid miner address: ' + addresses[idx] + ', error: ' + error);
                process.exit(1);
            }
        }
    }
}
