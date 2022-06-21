const net = require('net');
const events = require('events');
const util = require('./util.js');

var SubscriptionCounter = function(){
    var count = 0;
    var padding = 'deadbeefcafebabe';
    return {
        next: function(){
            count++;
            if (Number.MAX_SAFE_INTEGER === count) count = 0;
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Defining each client that connects to the stratum server.
 * Emits:
 *  - subscription(obj, cback(error, extraNonce1, extraNonce2Size))
 *  - submit(data(name, jobID, extraNonce2, ntime, nonce))
**/
var StratumClient = function(params){
    var pendingDifficulty = null;
    //private members
    this.socket = params.socket;

    this.remoteAddress = params.socket.remoteAddress;
    this.remotePort = params.socket.remotePort;

    var banning = params.banning;

    var _this = this;

    this.lastActivity = Date.now();

    this.shares = {valid: 0, invalid: 0};

    var considerBan = (!banning || !banning.enabled) ? function(){ return false } : function(shareValid){
        if (shareValid === true) _this.shares.valid++;
        else _this.shares.invalid++;
        var totalShares = _this.shares.valid + _this.shares.invalid;
        if (totalShares >= banning.checkThreshold){
            var percentBad = (_this.shares.invalid / totalShares) * 100;
            if (percentBad < banning.invalidPercent) //reset shares
                _this.shares = {valid: 0, invalid: 0};
            else {
                _this.emit('triggerBan', _this.shares.invalid + ' out of the last ' + totalShares + ' shares were invalid');
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    this.init = function init(){
        setupSocket();
    };

    function handleMessage(message){
        switch(message.method){
            case 'mining.submit':
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'alph_submitHashrate':
                break;
            case 'mining.subscribe':
                sendJson({
                    id: message.id,
                    result: "result"
                });
                break;
            case 'mining.authorize':
                sendJson({
                    id: message.id,
                    result: true
                });
                sendJson({
                    method: "mining.set_extranonce",
                    params: [(Math.floor(Math.random() * 65535)).toString(16).padStart(4, '0')],
                    id: null
                });
                break;
            default:
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    function handleSubmit(message){
        _this.emit('submit',
            message.params,
            function(error, result){
                if (!error && result){
                    _this.emit('submitAccepted');
                }
                if (!considerBan(result)){
                    sendJson({
                        id: message.id,
                        result: result,
                    });
                }
            }
        );

    }

    function sendJson(){
        var response = '';
        for (var i = 0; i < arguments.length; i++){
            response += JSON.stringify(arguments[i]) + '\n';
        }
        params.socket.write(response);
    }

    function setupSocket(){
        var socket = params.socket;
        var dataBuffer = '';
        socket.setEncoding('utf8');

        _this.emit('checkBan');
        _this.sendDifficulty(params.initDiff);
        socket.on('data', function(d){
            dataBuffer += d;
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240){ //10KB
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }
            if (dataBuffer.indexOf('\n') !== -1){
                var messages = dataBuffer.split('\n');
                var incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
                messages.forEach(function(message){
                    if (message === '') return;
                    var messageJson;
                    try {
                        messageJson = JSON.parse(message);
                    } catch(e) {
                        _this.emit('malformedMessage', message);
                        socket.destroy();
                        return;
                    }

                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });
                dataBuffer = incomplete;
            }
        });
        socket.on('close', function() {
            _this.emit('socketDisconnect');
        });
        socket.on('error', function(err){
            if (err.code !== 'ECONNRESET')
                _this.emit('socketError', err);
        });
    }

    this.getLabel = function(){
        return _this.remoteAddress + ':' + _this.remotePort;
    };

    this.enqueueNextDifficulty = function(requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
    };

    //public members

    /**
     * IF the given difficulty is valid and new it'll send it to the client.
     * returns boolean
     **/
    this.sendDifficulty = function(difficulty){
        if (difficulty === _this.difficulty)
            return false;

        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;
        _this.target = global.diff1Target.mul(1024).div(Math.ceil(_this.difficulty * 1024)).toBuffer().toString('hex');
        sendJson({
            id    : null,
            method: "mining.set_difficulty",
            params: [difficulty],
        });
        return true;
    };

    this.sendMiningJob = function(templates){

        var lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > params.connectionTimeout * 1000){
            _this.emit('socketTimeout', 'last submitted a share was ' + (lastActivityAgo / 1000 | 0) + ' seconds ago');
            _this.socket.destroy();
            return;
        }

        if (pendingDifficulty !== null){
            var result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }

        var jobParams = templates.map(template => {
            var p = template.getJobParams();
            p.targetBlob = _this.target;
            return p;
        });
        sendJson({
            id: null,
            method: "mining.notify",
            params: jobParams
        });
    };
};
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;

/**
 * The actual stratum server.
 * It emits the following Events:
 *   - 'client.connected'(StratumClientInstance) - when a new miner connects
 *   - 'client.disconnected'(StratumClientInstance) - when a miner disconnects. Be aware that the socket cannot be used anymore.
 *   - 'started' - when the server is up and running
 **/
var StratumServer = exports.Server = function StratumServer(config){

    //private members

    var bannedMS = config.banning ? config.banning.time * 1000 : null;
    var subscriptionCounter = SubscriptionCounter();

    var _this = this;
    this.connectionNumFromIP = {};
    this.stratumClients = {};
    this.bannedIPs = {};

    this.addConnectionFromIP = function(ipAddress){
        if (config.whitelistIps && config.whitelistIps.includes(ipAddress)){
            return true;
        }

        var connectionNum = _this.connectionNumFromIP[ipAddress];
        if (connectionNum){
            if (connectionNum >= config.maxConnectionsFromSameIP){
                return false;
            }
            _this.connectionNumFromIP[ipAddress] += 1;
            return true;
        }
        _this.connectionNumFromIP[ipAddress] = 1;
        return true;
    }

    this.removeConnectionFromIP = function(ipAddress){
        var connectionNum = _this.connectionNumFromIP[ipAddress];
        if (connectionNum && connectionNum > 0){
            var num = connectionNum - 1;
            if (num == 0){
                delete _this.connectionNumFromIP[ipAddress];
                return;
            }
            _this.connectionNumFromIP[ipAddress] = num;
        }
    }

    this.isBanned = function(address){
        if (config.banning && config.banning.enabled && address in _this.bannedIPs){
            var bannedTime = _this.bannedIPs[address];
            var bannedTimeAgo = Date.now() - bannedTime;
            var timeLeft = bannedMS - bannedTimeAgo;
            return [true, timeLeft];
        }
        return [false, null];
    }

    this.handleNewClient = function(socket){
        if (!_this.addConnectionFromIP(socket.remoteAddress)){
            _this.emit('tooManyConnectionsFromSameIP', socket.remoteAddress);
            socket.destroy();
            return;
        }

        socket.setNoDelay(true);
        var subscriptionId = subscriptionCounter.next();
        var client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                socket: socket,
                banning: config.banning,
                connectionTimeout: config.connectionTimeout,
                initDiff: config.pool.diff
            }
        );

        _this.stratumClients[subscriptionId] = client;
        _this.emit('client.connected', client);

        client.on('socketDisconnect', function() {
            _this.removeConnectionFromIP(client.remoteAddress);
            _this.removeClient(subscriptionId);
            _this.emit('client.disconnected', client);

        }).on('checkBan', function(){
            var [banned, timeLeft] = _this.isBanned(client.remoteAddress);
            if (!banned){
                return;
            }
            if (timeLeft > 0){
                client.socket.destroy();
                client.emit('kickedBannedIP', timeLeft / 1000 | 0);
            }
            else {
                delete _this.bannedIPs[client.remoteAddress];
                client.emit('forgaveBannedIP');
            }

        }).on('triggerBan', function(){
            _this.addBannedIP(client.remoteAddress);

        }).init();

        return subscriptionId;
    };


    this.broadcastMiningJobs = function(jobs){
        for (var clientId in _this.stratumClients) {
            var client = _this.stratumClients[clientId];
            client.sendMiningJob(jobs);
        }
    };

    (function init(){

        //Interval to look through bannedIPs for old bans and remove them in order to prevent a memory leak
        if (config.banning && config.banning.enabled){
            _this.timer = setInterval(function(){
                for (ip in _this.bannedIPs){
                    var banTime = _this.bannedIPs[ip];
                    if (Date.now() - banTime > config.banning.time)
                        delete _this.bannedIPs[ip];
                }
            }, 1000 * config.banning.purgeInterval);
        }

        var serverFactory = net.createServer;
        if (config.pool.proxyProtocol) {
            const proxiedNet = require('findhit-proxywrap').proxy(net);
            serverFactory = proxiedNet.createServer;
        }

        _this.server = serverFactory({allowHalfOpen: false}, function(socket) {
            _this.handleNewClient(socket);
        }).listen(config.pool.port, function() {
            _this.emit('started');
        });
    })();


    this.close = function(){
        clearInterval(_this.timer);
        _this.server.close();
    }

    this.addBannedIP = function(ipAddress){
        _this.bannedIPs[ipAddress] = Date.now();
    };

    this.removeClient = function(subscriptionId) {
        delete _this.stratumClients[subscriptionId];
    };
};
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;
