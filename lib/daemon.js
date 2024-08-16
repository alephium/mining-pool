const events = require('events');
const net = require('net');
const messages = require('./messages');
const constants = require('./constants');
const HttpClient = require('./httpClient');

function MinerClient(instance, logger){
    var client = net.Socket();
    var _this = this;

    this.connect = function(callback){
        client.removeAllListeners('close');
        client.removeAllListeners('error');
        client.removeAllListeners('data');
        client.removeAllListeners('connect');

        client.connect(instance.minerApiPort, instance.host);
        client.on('connect', function(){
            logger.info('Connected to alephium full node');
        });

        var buffer = Buffer.from([]);
        var tryParseMessage = function() {
            messages.parseMessage(buffer, function(message, offset){
                if (message){
                    buffer = buffer.slice(offset);
                    callback(message);
                    tryParseMessage();
                }
            })
        }
        client.on('data', function(data) {
            buffer = Buffer.concat([buffer, data]);
            tryParseMessage();
        });

        client.on('error', function(error){
            logger.error('Full node connection error: ' + error);
        });

        client.on('close', function(){
            logger.warn('Full node connection closed, trying to reconnect...');
            setTimeout(function(){
                _this.connect(callback);
            }, 8000);
        });
    }

    this.submit = function(block, callback){
        var blockSize = block.length;
        var msgPrefixSize = 1 + 1 + 4; // version(1 byte) + messageType(1 byte) + encodedBlockSize(4 bytes)
        var msgSize = msgPrefixSize + blockSize;
        var msgHeader = Buffer.alloc(10); // encodedMessageSize(4 bytes) + msgPrefixSize
        msgHeader.writeUInt32BE(msgSize);
        msgHeader.writeUInt8(constants.MiningProtocolVersion, 4)
        msgHeader.writeUInt8(constants.SubmitBlockMessageType, 5);
        msgHeader.writeUInt32BE(blockSize, 6);
        var data = Buffer.concat([msgHeader, block]);
        client.write(data, callback);
    }
}

/**
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
**/

function DaemonInterface(instance, logger){

    //private members
    var _this = this;

    this.httpClient = new HttpClient(instance.host, instance.port, instance.apiKey);

    this.init = function(){
        _this.httpClient.selfClique(function(result){
            if (result.selfReady){
                _this.emit('online');
            }
            else {
                _this.emit('cliqueNotReady');
            }
        });
    }

    this.isSynced = function(callback){
        _this.httpClient.selfClique(function(result){
            callback(result.selfReady && result.synced);
        });
    }

    this.connectToMiningServer = function(callback){
        _this.minerClient = new MinerClient(instance, logger);
        _this.minerClient.connect(callback);
    }

    this.submit = function(block, callback){
        _this.minerClient.submit(block, callback);
    }
}

DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

exports.interface = DaemonInterface;
