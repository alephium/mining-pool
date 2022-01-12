const events = require('events');
const Redis = require('ioredis');
const varDiff = require('./varDiff.js');
const daemon = require('./daemon.js');
const stratum = require('./stratum.js');
const { JobManager } = require('./jobManager.js');
const constants = require('./constants.js');
const ShareProcessor = require('./shareProcessor.js');
const PaymentProcessor = require('./paymentProcessor.js');
const Stats = require('./stats.js');

var pool = module.exports = function pool(config, logger){
    var topicNameClient = "workers-events";
    var topicNameShares = "shares-events";

    this.redisClient = new Redis(config.redis.port, config.redis.host);
    this.config = config;
    var _this = this;
    var jobExpiryPeriod = config.jobExpiryPeriod * 1000; // ms

    this.start = function(){
        SetupVarDiff();
        SetupDaemonInterface(function(){
            SetupJobManager();
            OnBlockchainSynced(function(){
                StartShareProcessor();
                StartPaymentProcessor();
                StartStatsReport();
                StartStratumServer();
            });
        });
    };

    function OnBlockchainSynced(syncedCallback){

        var checkSynced = function(displayNotSynced){
            _this.daemon.isSynced(function(synced){
                if (synced){
                    syncedCallback();
                }
                else{
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);
                }
            });
        };
        checkSynced(function(){
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                logger.info('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });
    }

    function SetupVarDiff(){
        _this.varDiff = new varDiff(config.pool.varDiff);
        _this.varDiff.on('newDifficulty', function(client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);
        });
    }

    function SetupJobManager(){

        _this.jobManager = new JobManager();

        _this.jobManager.on('newJobs', function(templates){
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(templates);
            }
        }).on('share', function(shareData){
            if (shareData.error){
                // we only emit valid shares
                logger.error('Invalid share from ' + shareData.worker +
                    ', error: ' + shareData.error +
                    ', jobId: ' + shareData.job +
                    ', ip: ' + shareData.ip
                );
                return;
            }

            var job = shareData.job;
            var chainIndex = chainIndexStr(job.fromGroup, job.toGroup);
            logger.info('Received share from ' + shareData.worker +
                ', jobId: ' + job.jobId +
                ', chainIndex: ' + chainIndex +
                ', pool difficulty: ' + shareData.difficulty +
                ', share difficulty: ' + shareData.shareDiff +
                ', ip: ' + shareData.ip
            );
            _this.redisClient.publish(topicNameShares,JSON.stringify({
                workerAddr: shareData.worker,
                jobId: job.jobId,
                fromGroup: job.fromGroup,
                toGroup: job.toGroup,
                pool_difficulty: shareData.difficulty,
                share_difficulty: shareData.shareDiff,
                ip: shareData.ip
            }))
            _this.shareProcessor.handleShare(shareData);
            if (shareData.foundBlock){
                logger.info('Found block for chainIndex: ' + chainIndex +
                    ', hash: ' + shareData.blockHash +
                    ', miner: ' + shareData.worker
                );

                var block = Buffer.concat([shareData.nonce, job.headerBlob, job.txsBlob]);
                _this.daemon.submit(block, function(error){
                    if (error) {
                        logger.error('Submit block error: ' + error);
                    }
                });
            }
        })
    }

    function chainIndexStr(fromGroup, toGroup){
        return fromGroup + " -> " + toGroup;
    }

    function SetupDaemonInterface(finishedCallback){

        if (!config.daemon) {
            logger.error('No daemons have been configured - pool cannot start');
            return;
        }

        // TODO: support backup daemons
        _this.daemon = new daemon.interface(config.daemon, logger);

        _this.daemon.once('online', function(){
            finishedCallback();
            _this.daemon.connectToMiningServer(messageHandler);

        }).on('cliqueNotReady', function(){
            logger.info('Clique is not ready.');

        }).on('error', function(message){
            logger.error(message);

        });

        _this.daemon.init();
    }

    function messageHandler(message){
        switch(message.type) {
            case constants.JobsMessageType:
                _this.jobManager.processJobs(message.payload);
                break;
            case constants.SubmitResultMessageType:
                var result = message.payload;
                handleSubmitResult(result.fromGroup, result.toGroup, result.succeed);
                break;
            default:
                logger.error('Invalid message type: ' + message.type);
        }
    }

    function handleSubmitResult(fromGroup, toGroup, succeed){
        var chainIndex = chainIndexStr(fromGroup, toGroup);
        if (succeed){
            logger.info('Submit block succeed for chainIndex: ' + chainIndex);
        }
        else {
            logger.error('Submit block failed for chainIndex: ' + chainIndex);
        }
    }

    function StartShareProcessor(){
        _this.shareProcessor = new ShareProcessor(config, logger);
        _this.shareProcessor.start();
    }

    function StartPaymentProcessor(){
        _this.paymentProcessor = new PaymentProcessor(config, logger);
        _this.paymentProcessor.start();
    }

    function StartStatsReport(){
        _this.stats = new Stats(config, logger);
        _this.stats.reportStatsRegularly();
    }

    function StartStratumServer(){
        _this.stratumServer = new stratum.Server(config);

        _this.stratumServer.on('started', function(){
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJobs);
        }).on('tooManyConnectionsFromSameIP', function(ipAddress){
            logger.warn('Too many connections from IP: ' + ipAddress);

        }).on('client.connected', function(client){
            logger.info('New miner connected: ' + client.getLabel());

            _this.redisClient.publish(topicNameClient,JSON.stringify({
                state: 'connected',
                ip: client.remoteAddress,
                port: client.remotePort
            }))
            _this.varDiff.manageClient(client);

            client.on('submit', function(params, resultCallback){
                var result =_this.jobManager.processShare(
                    params,
                    client.previousDifficulty,
                    client.difficulty,
                    client.remoteAddress,
                    client.socket.localPort,
                    jobExpiryPeriod
                );
                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', function (message) {
                logger.warn('Malformed message from ' + client.getLabel() + ': ' + message);
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'malformedMessage',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('socketError', function(err) {
                logger.warn('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'socketError',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('socketTimeout', function(reason){
                logger.warn('Connected timed out for ' + client.getLabel() + ': ' + reason)
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'socketTimeout',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('socketDisconnect', function() {
                logger.warn('Socket disconnected from ' + client.getLabel());
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'socketDisconnected',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('difficultyChanged', function(difficulty){
                logger.info('Set new difficulty for ' + client.getLabel() + ' to ' + difficulty);

            }).on('kickedBannedIP', function(remainingBanTime){
                logger.info('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'kickedBannedIP',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('forgaveBannedIP', function(){
                logger.info('Forgave banned IP ' + client.remoteAddress);
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'unbanned',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('unknownStratumMethod', function(fullMessage) {
                logger.error('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'unknownStratumMethod',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))

            }).on('socketFlooded', function() {
                logger.warn('Detected socket flooding from ' + client.getLabel());
                const data = {
                    state: 'socketFlooded',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }
                _this.redisClient.publish(topicNameClient,JSON.stringify(data))
                logger.info("send to channel "+topicNameClient+": "+JSON.stringify(data))

            }).on('triggerBan', function(reason){
                logger.info('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.redisClient.publish(topicNameClient,JSON.stringify({
                    state: 'triggerBan',
                    ip: client.remoteAddress,
                    port: client.remotePort
                }))
            });
        }).on('client.disconnected', function(client){
            logger.info('Client ' + client.getLabel() + ' disconnected');
            _this.redisClient.publish(topicNameClient,JSON.stringify({
                state: 'disconnected',
                ip: client.remoteAddress,
                port: client.remotePort
            }))
        });
    }
};
pool.prototype.__proto__ = events.EventEmitter.prototype;
