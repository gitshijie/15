'use strict';

/**
 * Module dependencies
 */
import { EventEmitter } from 'events';
import Store from './store';
import { TopicAliasRecv } from './topic-alias-recv';
import { TopicAliasSend } from './topic-alias-send';
import mqttPacket from 'mqtt-packet';
import { DefaultMessageIdProvider } from './default-message-id-provider';
import { Readable, Writable } from 'readable-stream';
const reInterval = require('reinterval');
import rfdc from 'rfdc';
import * as validations from './validations';
import debugModule from 'debug';
import { MqttClientOptions } from './options';
import { MessageIdProvider } from './message-id-provider';
import { StreamBuilderFunction } from './connect/interface';

const debug = debugModule('mqttjs:client');
const clone = rfdc();

const defaultConnectOptions: MqttClientOptions = {
  keepalive: 60,
  reschedulePings: true,
  protocolId: 'MQTT',
  protocolVersion: 4,
  reconnectPeriod: 1000,
  connectTimeout: 30 * 1000,
  clean: true,
  resubscribe: true,
};

export interface PublishOptions {
  qos?: mqttPacket.QoS;
  retain?: boolean;
  dup?: boolean;
  cbStorePut?: () => void;
  properties?: mqttPacket.IPublishPacket['properties'];
}

export interface ISubscriptionExtended extends mqttPacket.ISubscription {
  properties?: {};
}

const socketErrors = ['ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET', 'ENOTFOUND'];

type OutgoingQueueEntryCallback = (err?: Error, packet?: mqttPacket.Packet) => void;
interface OutgoingQueueEntry {
  volatile: boolean;
  cb: OutgoingQueueEntryCallback;
}
type OutgoingQueue = { [key: string]: OutgoingQueueEntry };

type SendPacketCompleteCallback = (err?: Error) => void;
type StorePutCompleteCallback = (err?: Error) => void;

interface StoreProcessingQueueEntry {
  invoke: () => boolean;
  cbStorePut?: StorePutCompleteCallback;
  callback: SendPacketCompleteCallback;
}
// Other Socket Errors: EADDRINUSE, ECONNRESET, ENOTFOUND.
type ErrorOnlyCallback = (err?: Error) => void;

interface ResubscribeTopicList {
  resubscribe?: boolean;
  [key: string]: ISubscriptionExtended | boolean | undefined;
}

const errors: { [errno: number]: string } = {
  0: '',
  1: 'Unacceptable protocol version',
  2: 'Identifier rejected',
  3: 'Server unavailable',
  4: 'Bad username or password',
  5: 'Not authorized',
  16: 'No matching subscribers',
  17: 'No subscription existed',
  128: 'Unspecified error',
  129: 'Malformed Packet',
  130: 'Protocol Error',
  131: 'Implementation specific error',
  132: 'Unsupported Protocol Version',
  133: 'Client Identifier not valid',
  134: 'Bad User Name or Password',
  135: 'Not authorized',
  136: 'Server unavailable',
  137: 'Server busy',
  138: 'Banned',
  139: 'Server shutting down',
  140: 'Bad authentication method',
  141: 'Keep Alive timeout',
  142: 'Session taken over',
  143: 'Topic Filter invalid',
  144: 'Topic Name invalid',
  145: 'Packet identifier in use',
  146: 'Packet Identifier not found',
  147: 'Receive Maximum exceeded',
  148: 'Topic Alias invalid',
  149: 'Packet too large',
  150: 'Message rate too high',
  151: 'Quota exceeded',
  152: 'Administrative action',
  153: 'Payload format invalid',
  154: 'Retain not supported',
  155: 'QoS not supported',
  156: 'Use another server',
  157: 'Server moved',
  158: 'Shared Subscriptions not supported',
  159: 'Connection rate exceeded',
  160: 'Maximum connect time',
  161: 'Subscription Identifiers not supported',
  162: 'Wildcard Subscriptions not supported',
};

function defaultId(): string {
  return 'mqttjs_' + Math.random().toString(16).substr(2, 8);
}

function applyTopicAlias(client: MqttClient, packet: mqttPacket.Packet): Error | undefined {
  if (client.options.protocolVersion === 5) {
    if (packet.cmd === 'publish') {
      let alias;
      if (packet.properties) {
        alias = packet.properties.topicAlias;
      }
      const topic = packet.topic.toString();
      if (client.topicAliasSend) {
        if (alias) {
          if (topic.length !== 0) {
            // register topic alias
            debug('applyTopicAlias :: register topic: %s - alias: %d', topic, alias);
            if (!client.topicAliasSend.put(topic, alias)) {
              debug('applyTopicAlias :: error out of range. topic: %s - alias: %d', topic, alias);
              return new Error('Sending Topic Alias out of range');
            }
          }
        } else {
          if (topic.length !== 0) {
            if (client.options.autoAssignTopicAlias) {
              alias = client.topicAliasSend.getAliasByTopic(topic);
              if (alias) {
                packet.topic = '';
                packet.properties = { ...packet.properties, topicAlias: alias };
                debug('applyTopicAlias :: auto assign(use) topic: %s - alias: %d', topic, alias);
              } else {
                alias = client.topicAliasSend.getLruAlias();
                client.topicAliasSend.put(topic, alias);
                packet.properties = { ...packet.properties, topicAlias: alias };
                debug('applyTopicAlias :: auto assign topic: %s - alias: %d', topic, alias);
              }
            } else if (client.options.autoUseTopicAlias) {
              alias = client.topicAliasSend.getAliasByTopic(topic);
              if (alias) {
                packet.topic = '';
                packet.properties = { ...packet.properties, topicAlias: alias };
                debug('applyTopicAlias :: auto use topic: %s - alias: %d', topic, alias);
              }
            }
          }
        }
      } else if (alias) {
        debug('applyTopicAlias :: error out of range. topic: %s - alias: %d', topic, alias);
        return new Error('Sending Topic Alias out of range');
      }
    }
  }
  return undefined;
}

function removeTopicAliasAndRecoverTopicName(client: MqttClient, packet: mqttPacket.IPublishPacket): Error | undefined {
  const alias = packet.properties?.topicAlias;
  if (!packet.topic.toString()) {
    // restore topic from alias
    if (!alias) {
      return new Error('Unregistered Topic Alias');
    } else {
      const topic = client.topicAliasSend!.getTopicByAlias(alias);
      if (!topic) {
        return new Error('Unregistered Topic Alias');
      } else {
        packet.topic = topic;
      }
    }
  }
  if (alias) {
    delete packet.properties!.topicAlias;
  }
  return undefined;
}

function sendPacket(client: MqttClient, packet: mqttPacket.Packet, cb?: () => void): void {
  debug('sendPacket :: packet: %O', packet);
  debug('sendPacket :: emitting `packetsend`');

  client.emit('packetsend', packet);

  debug('sendPacket :: writing to stream');
  const result: boolean = mqttPacket.writeToStream(packet, client.stream, client.options) as any;
  debug('sendPacket :: writeToStream result %s', result);
  if (!result && cb && cb !== nop) {
    debug('sendPacket :: handle events on `drain` once through callback.');
    client.stream.once('drain', cb);
  } else if (cb) {
    debug('sendPacket :: invoking cb');
    cb();
  }
}

function flush(queue: OutgoingQueue) {
  if (queue) {
    debug('flush: queue exists? %b', !!queue);
    Object.keys(queue).forEach((messageId: string): void => {
      const cb = queue[messageId]?.cb;
      if (typeof cb === 'function') {
        cb(new Error('Connection closed'));
        // TODO: This is suspicious.  Why do we only delete this if we have a callback?
        // If this is by-design, then adding no as callback would cause this to get deleted unintentionally.
        delete queue[messageId];
      }
    });
  }
}

function flushVolatile(queue: OutgoingQueue) {
  if (queue) {
    debug('flushVolatile :: deleting volatile messages from the queue and setting their callbacks as error function');
    Object.keys(queue).forEach((messageId: string): void => {
      const queueItem = queue[messageId];
      if (queueItem && queueItem.volatile && typeof queueItem.cb === 'function') {
        queueItem.cb(new Error('Connection closed'));
        // TODO: same as in flush above, this is suspicious.  Why do we only delete this if we have a callback?
        delete queue[messageId];
      }
    });
  }
}

function storeAndSend(
  client: MqttClient,
  packet: mqttPacket.IPublishPacket | mqttPacket.IPubrelPacket,
  cb: SendPacketCompleteCallback,
  cbStorePut: StorePutCompleteCallback
) {
  debug('storeAndSend :: store packet with cmd %s to outgoingStore', packet.cmd);
  let storePacket = packet;
  let err;
  if (storePacket.cmd === 'publish') {
    // The original packet is for sending.
    // The cloned storePacket is for storing to resend on reconnect.
    // Topic Alias must not be used after disconnected.
    storePacket = clone(packet);
    err = removeTopicAliasAndRecoverTopicName(client, storePacket as mqttPacket.IPublishPacket);
    if (err) {
      return cb && cb(err);
    }
  }
  client.outgoingStore.put(storePacket, (err?: Error): void => {
    if (err) {
      return cb && cb(err);
    }
    cbStorePut();
    sendPacket(client, packet, cb);
  });
}

function nop(error?: Error): void {
  debug('nop ::', error);
}

export default class MqttClient extends EventEmitter {
  public options: MqttClientOptions;
  public topicAliasSend?: TopicAliasSend;
  public topicAliasRecv?: TopicAliasRecv;
  public outgoingStore: Store;
  public incomingStore: Store;
  public outgoing: OutgoingQueue;
  public stream: any;
  public streamBuilder: StreamBuilderFunction;
  public messageIdProvider: MessageIdProvider;
  public queueQoSZero: boolean;
  public connected: boolean;
  public disconnecting: boolean;
  public connackTimer: any;
  public reconnectTimer: any;
  public pingTimer: any;
  private _firstConnection: boolean;
  private messageIdToTopic: { [messageId: number]: string[] };
  private queue: { packet: mqttPacket.Packet; cb: (err?: Error) => void }[];
  private _storeProcessing: boolean;
  private _packetIdsDuringStoreProcessing: { [id: number]: boolean };
  private _storeProcessingQueue: StoreProcessingQueueEntry[];
  private _resubscribeTopics: ResubscribeTopicList;
  private _deferredReconnect?: () => void;
  public reconnecting?: boolean;
  private connackPacket?: mqttPacket.IConnackPacket;
  public disconnected?: boolean;
  public pingResp?: boolean;
  public _reconnectCount?: number;

  /**
   * MqttClient constructor
   *
   * @param {Stream} stream - stream
   * @param {Object} [options] - connection options
   * (see Connection#connect)
   */
  constructor(streamBuilder: StreamBuilderFunction, options: MqttClientOptions = {}) {
    super();

    this.options = options || {};

    // Defaults
    for (const k in defaultConnectOptions as any) {
      if ((this.options as any)[k] == undefined) {
        (this.options as any)[k] = (defaultConnectOptions as any)[k];
      }
    }

    this.options.clientId = typeof options.clientId === 'string' ? options.clientId : defaultId();

    debug('MqttClient :: options:');
    const opt: { [key: string]: any } = this.options as any;
    for (const key in opt) {
      if (Object.prototype.hasOwnProperty.call(opt, key)) {
        debug('%s: %s', key, opt[key]);
      }
    }

    this.options.customHandleAcks =
      options.protocolVersion === 5 && options.customHandleAcks
        ? options.customHandleAcks
        : (_topic: string, _message: any, _packet: mqttPacket.Packet, callback: (err?: Error, code?: any) => void): void => {
            callback(undefined, 0);
          };

    this.streamBuilder = streamBuilder;

    this.messageIdProvider = this.options.messageIdProvider || new DefaultMessageIdProvider();

    // Inflight message storages
    this.outgoingStore = options.outgoingStore || new Store();
    this.incomingStore = options.incomingStore || new Store();

    // Should QoS zero messages be queued when the connection is broken?
    this.queueQoSZero = options.queueQoSZero == undefined ? true : options.queueQoSZero;

    // map of subscribed topics to support reconnection
    this._resubscribeTopics = {};

    // map of a subscribe messageId and a topic
    this.messageIdToTopic = {};

    // Ping timer, setup in _setupPingTimer
    this.pingTimer = undefined;
    // Is the client connected?
    this.connected = false;
    // Are we disconnecting?
    this.disconnecting = false;
    // Packet queue
    this.queue = [];
    // connack timer
    this.connackTimer = undefined;
    // Reconnect timer
    this.reconnectTimer = undefined;
    // Is processing store?
    this._storeProcessing = false;
    // Packet Ids are put into the store during store processing
    this._packetIdsDuringStoreProcessing = {};
    // Store processing queue
    this._storeProcessingQueue = [];

    // Inflight callbacks
    this.outgoing = {};

    // True if connection is first time.
    this._firstConnection = true;

    if (options.topicAliasMaximum && options.topicAliasMaximum > 0) {
      if (options.topicAliasMaximum > 0xffff) {
        debug('MqttClient :: options.topicAliasMaximum is out of range');
      } else {
        this.topicAliasRecv = new TopicAliasRecv(options.topicAliasMaximum);
      }
    }

    // Send queued packets
    this.on('connect', (): void => {
      const queue = this.queue;

      const deliver = (): void => {
        const entry = queue.shift();
        debug('deliver :: entry %o', entry);
        let packet = undefined;

        if (!entry) {
          this._resubscribe();
          return;
        }

        packet = entry.packet;
        debug('deliver :: call _sendPacket for %o', packet);
        let send = true;
        if (packet.messageId && packet.messageId !== 0) {
          if (!this.messageIdProvider.register(packet.messageId)) {
            send = false;
          }
        }
        if (send) {
          this._sendPacket(packet, (err?: Error): void => {
            if (entry.cb) {
              entry.cb(err);
            }
            deliver();
          });
        } else {
          debug('messageId: %d has already used. The message is skipped and removed.', packet.messageId);
          deliver();
        }
      };

      debug('connect :: sending queued packets');
      deliver();
    });

    this.on('close', (): void => {
      debug('close :: connected set to `false`');
      this.connected = false;

      debug('close :: clearing connackTimer');
      clearTimeout(this.connackTimer);

      debug('close :: clearing ping timer');
      if (this.pingTimer != undefined) {
        this.pingTimer.clear();
        this.pingTimer = undefined;
      }

      if (this.topicAliasRecv) {
        this.topicAliasRecv.clear();
      }

      debug('close :: calling _setupReconnect');
      this._setupReconnect();
    });
    EventEmitter.call(this);

    debug('MqttClient :: setting up stream');
    this._setupStream();
  }

  /**
   * setup the event handlers in the inner stream.
   *
   * @api private
   */
  private _setupStream(): this {
    const writable = new Writable();
    const parser = mqttPacket.parser(this.options);
    let completeParse: (() => void) | undefined;
    const packets: mqttPacket.Packet[] = [];

    debug('_setupStream :: calling method to clear reconnect');
    this._clearReconnect();

    debug('_setupStream :: using streamBuilder provided to client to create stream');
    this.stream = this.streamBuilder(this, this.options);

    parser.on('packet', (packet: mqttPacket.Packet): void => {
      debug('parser :: on packet push to packets array.');
      packets.push(packet);
    });

    const nextTickWork = (): void => {
      if (packets.length) {
        process.nextTick(work);
      } else {
        const done = completeParse;
        completeParse = undefined;
        if (done) {
          done();
        }
      }
    };

    const work = (): void => {
      debug('work :: getting next packet in queue');
      const packet = packets.shift();

      if (packet) {
        debug('work :: packet pulled from queue');
        this._handlePacket(packet, nextTickWork);
      } else {
        debug('work :: no packets in queue');
        const done = completeParse;
        completeParse = undefined;
        debug('work :: done flag is %s', !!done);
        if (done) done();
      }
    };

    writable._write = (buf: any, _enc: string, done: (err?: Error) => void): void => {
      completeParse = done;
      debug('writable stream :: parsing buffer');
      parser.parse(buf);
      work();
    };

    const streamErrorHandler = (error: Error): void => {
      debug('streamErrorHandler :: error', error.message);
      if (socketErrors.includes((error as any).code)) {
        // handle error
        debug('streamErrorHandler :: emitting error');
        this.emit('error', error);
      } else {
        nop(error);
      }
    };

    debug('_setupStream :: pipe stream to writable stream');
    this.stream.pipe(writable);

    // Suppress connection errors
    this.stream.on('error', streamErrorHandler);

    // Echo stream close
    this.stream.on('close', (): void => {
      debug('(%s)stream :: on close', this.options.clientId);
      flushVolatile(this.outgoing);
      debug('stream: emit close to MqttClient');
      this.emit('close');
    });

    // Send a connect packet
    debug('_setupStream: sending packet `connect`');
    const connectPacket = Object.create(this.options);
    connectPacket.cmd = 'connect';
    if (this.topicAliasRecv) {
      if (!connectPacket.properties) {
        connectPacket.properties = {};
      }
      if (this.topicAliasRecv) {
        connectPacket.properties.topicAliasMaximum = this.topicAliasRecv.max;
      }
    }
    // avoid message queue
    sendPacket(this, connectPacket);

    // Echo connection errors
    parser.on('error', this.emit.bind(this, 'error'));

    // auth
    if (this.options.properties) {
      if (!this.options.properties.authenticationMethod && this.options.properties.authenticationData) {
        this.end(() => this.emit('error', new Error('Packet has no Authentication Method')));
        return this;
      }
      if (this.options.properties.authenticationMethod && this.options.authPacket && typeof this.options.authPacket === 'object') {
        const authPacket = { cmd: 'auth', reasonCode: 0, ...this.options.authPacket };
        sendPacket(this, authPacket);
      }
    }

    // many drain listeners are needed for qos 1 callbacks if the connection is intermittent
    this.stream.setMaxListeners(1000);

    clearTimeout(this.connackTimer);
    this.connackTimer = setTimeout((): void => {
      debug('!!connectTimeout hit!! Calling _cleanUp with force `true`');
      this._cleanUp(true);
    }, this.options.connectTimeout);

    return this;
  }

  private _handlePacket(packet: mqttPacket.Packet, done: (err?: Error) => void): void {
    const options = this.options;

    if (
      options.protocolVersion === 5 &&
      options.properties &&
      options.properties.maximumPacketSize &&
      options.properties.maximumPacketSize < (packet.length as number)
    ) {
      this.emit('error', new Error('exceeding packets size ' + packet.cmd));
      this.end({ reasonCode: 149, properties: { reasonString: 'Maximum packet size was exceeded' } });
      return;
    }
    debug('_handlePacket :: emitting packetreceive');
    this.emit('packetreceive', packet);

    switch (packet.cmd) {
      case 'publish':
        this._handlePublish(packet, done);
        break;
      case 'puback':
      case 'pubrec':
      case 'pubcomp':
      case 'suback':
      case 'unsuback':
        this._handleAck(packet);
        done();
        break;
      case 'pubrel':
        this._handlePubrel(packet, done);
        break;
      case 'connack':
        this._handleConnack(packet);
        done();
        break;
      case 'auth':
        this._handleAuth(packet);
        done();
        break;
      case 'pingresp':
        this._handlePingresp(packet);
        done();
        break;
      case 'disconnect':
        this._handleDisconnect(packet);
        done();
        break;
      default:
        // do nothing
        // maybe we should do an error handling
        // or just log it
        break;
    }
  }

  private _checkDisconnecting(callback: (err?: Error) => void): boolean {
    if (this.disconnecting) {
      if (callback && callback !== nop) {
        callback(new Error('client disconnecting'));
      } else {
        this.emit('error', new Error('client disconnecting'));
      }
    }
    return this.disconnecting;
  }

  /**
   * publish - publish <message> to <topic>
   *
   * @param {String} topic - topic to publish to
   * @param {String, Buffer} message - message to publish
   * @param {Object} [opts] - publish options, includes:
   *    {Number} qos - qos level to publish on
   *    {Boolean} retain - whether or not to retain the message
   *    {Boolean} dup - whether or not mark a message as duplicate
   *    {Function} cbStorePut - function(){} called when message is put into `outgoingStore`
   * @param {Function} [callback] - function(err){}
   *    called when publish succeeds or fails
   * @returns {MqttClient} this - for chaining
   * @api public
   *
   * @example client.publish('topic', 'message');
   * @example
   *     client.publish('topic', 'message', {qos: 1, retain: true, dup: true});
   * @example client.publish('topic', 'message', console.log);
   */
  public publish(topic: string, message: string | Buffer, opts: PublishOptions, callback: (err?: Error) => void): this {
    debug('publish :: message `%s` to topic `%s`', message, topic);
    const options = this.options;

    // .publish(topic, payload, cb);
    if (typeof opts === 'function') {
      callback = opts;
      opts = {};
    }

    // default opts
    const defaultOpts: PublishOptions = { qos: 0, retain: false, dup: false };
    opts = { ...defaultOpts, ...opts };

    if (this._checkDisconnecting(callback)) {
      return this;
    }

    const publishProc = (): boolean => {
      let messageId = 0;
      if (opts.qos === 1 || opts.qos === 2) {
        messageId = this._nextId();
        if (messageId == undefined) {
          debug('No messageId left');
          return false;
        }
      }
      const packet: mqttPacket.IPublishPacket = {
        cmd: 'publish',
        topic: topic,
        payload: message,
        qos: opts.qos || 0,
        retain: opts.retain || false,
        messageId: messageId,
        dup: opts.dup || false,
      };

      if (options.protocolVersion === 5) {
        packet.properties = opts.properties;
      }

      debug('publish :: qos', opts.qos);
      switch (opts.qos) {
        case 1:
        case 2:
          // Add to callbacks
          this.outgoing[packet.messageId as number] = {
            volatile: false,
            cb: callback || nop,
          };
          debug('MqttClient:publish: packet cmd: %s', packet.cmd);
          this._sendPacket(packet, undefined, opts.cbStorePut);
          break;
        default:
          debug('MqttClient:publish: packet cmd: %s', packet.cmd);
          this._sendPacket(packet, callback, opts.cbStorePut);
          break;
      }
      return true;
    };

    if (this._storeProcessing || this._storeProcessingQueue.length > 0 || !publishProc()) {
      this._storeProcessingQueue.push({
        invoke: publishProc,
        cbStorePut: opts.cbStorePut,
        callback: callback,
      });
    }
    return this;
  }

  /**
   * subscribe - subscribe to <topic>
   *
   * @param {String, Array, Object} topic - topic(s) to subscribe to, supports objects in the form {'topic': qos}
   * @param {Object} [opts] - optional subscription options, includes:
   *    {Number} qos - subscribe qos level
   * @param {Function} [callback] - function(err, granted){} where:
   *    {Error} err - subscription error (none at the moment!)
   *    {Array} granted - array of {topic: 't', qos: 0}
   * @returns {MqttClient} this - for chaining
   * @api public
   * @example client.subscribe('topic');
   * @example client.subscribe('topic', {qos: 1});
   * @example client.subscribe({'topic': {qos: 0}, 'topic2': {qos: 1}}, console.log);
   * @example client.subscribe('topic', console.log);
   */
  public subscribe(...args: any[]) {
    const subs: ISubscriptionExtended[] = [];
    let obj: any = args.shift();
    const resubscribe = obj.resubscribe;
    let callback = args.pop() || nop;
    let opts: ISubscriptionExtended = args.pop();
    const version = this.options.protocolVersion;

    delete obj.resubscribe;

    if (typeof obj === 'string') {
      obj = [obj];
    }

    if (typeof callback !== 'function') {
      opts = callback;
      callback = nop;
    }

    const invalidTopic = validations.validateTopics(obj);
    if (invalidTopic != undefined) {
      setImmediate(callback, new Error('Invalid topic ' + invalidTopic));
      return this;
    }

    if (this._checkDisconnecting(callback)) {
      debug('subscribe: disconnecting true');
      return this;
    }

    const defaultOpts: any = {
      qos: 0,
    };
    if (version === 5) {
      defaultOpts.nl = false;
      defaultOpts.rap = false;
      defaultOpts.rh = 0;
    }
    opts = { ...defaultOpts, ...opts };

    if (Array.isArray(obj)) {
      obj.forEach((topic: string): void => {
        debug('subscribe: array topic %s', topic);
        if (
          !Object.prototype.hasOwnProperty.call(this._resubscribeTopics, topic) ||
          (this._resubscribeTopics[topic] as ISubscriptionExtended).qos < opts.qos ||
          resubscribe
        ) {
          const currentOpts: ISubscriptionExtended = {
            topic: topic,
            qos: opts.qos,
          };
          if (version === 5) {
            currentOpts.nl = opts.nl;
            currentOpts.rap = opts.rap;
            currentOpts.rh = opts.rh;
            currentOpts.properties = opts.properties;
          }
          debug('subscribe: pushing topic `%s` and qos `%s` to subs list', currentOpts.topic, currentOpts.qos);
          subs.push(currentOpts);
        }
      });
    } else {
      Object.keys(obj).forEach((k: string): void => {
        debug('subscribe: object topic %s', k);
        if (
          !Object.prototype.hasOwnProperty.call(this._resubscribeTopics, k) ||
          (this._resubscribeTopics[k] as ISubscriptionExtended).qos < obj[k].qos ||
          resubscribe
        ) {
          const currentOpts: ISubscriptionExtended = {
            topic: k,
            qos: obj[k].qos,
          };
          if (version === 5) {
            currentOpts.nl = obj[k].nl;
            currentOpts.rap = obj[k].rap;
            currentOpts.rh = obj[k].rh;
            currentOpts.properties = opts.properties;
          }
          debug('subscribe: pushing `%s` to subs list', currentOpts);
          subs.push(currentOpts);
        }
      });
    }

    if (!subs.length) {
      callback(undefined, []);
      return this;
    }

    const subscribeProc = (): boolean => {
      const messageId = this._nextId();
      if (messageId == undefined) {
        debug('No messageId left');
        return false;
      }

      const packet: any = {
        cmd: 'subscribe',
        qos: 1,
        retain: false,
        dup: false,
        subscriptions: subs,
        messageId: messageId,
      };

      if (opts.properties) {
        packet.properties = opts.properties;
      }

      // subscriptions to resubscribe to in case of disconnect
      if (this.options.resubscribe) {
        debug('subscribe :: resubscribe true');
        const topics: string[] = [];
        subs.forEach((sub: any): void => {
          if (this.options.reconnectPeriod && this.options.reconnectPeriod > 0) {
            const topic: any = { qos: sub.qos };
            if (version === 5) {
              topic.nl = sub.nl || false;
              topic.rap = sub.rap || false;
              topic.rh = sub.rh || 0;
              topic.properties = sub.properties;
            }
            this._resubscribeTopics[sub.topic] = topic;
            topics.push(sub.topic);
          }
        });
        this.messageIdToTopic[packet.messageId as number] = topics;
      }

      this.outgoing[packet.messageId as number] = {
        volatile: true,
        cb: (err?: Error, packet?: mqttPacket.Packet): void => {
          if (!err) {
            const granted = (packet as mqttPacket.ISubackPacket).granted;
            for (let i = 0; i < granted.length; i += 1) {
              subs[i]!.qos = granted[i] as mqttPacket.QoS;
            }
          }

          callback(err, subs);
        },
      };
      debug('subscribe :: call _sendPacket');
      this._sendPacket(packet);
      return true;
    };

    if (this._storeProcessing || this._storeProcessingQueue.length > 0 || !subscribeProc()) {
      this._storeProcessingQueue.push({
        invoke: subscribeProc,
        callback: callback,
      });
    }

    return this;
  }

  /**
   * unsubscribe - unsubscribe from topic(s)
   *
   * @param {String, Array} topic - topics to unsubscribe from
   * @param {Object} [opts] - optional subscription options, includes:
   *    {Object} properties - properties of unsubscribe packet
   * @param {Function} [callback] - callback fired on unsuback
   * @returns {MqttClient} this - for chaining
   * @api public
   * @example client.unsubscribe('topic');
   * @example client.unsubscribe('topic', console.log);
   */
  public unsubscribe() {
    const args = new Array(arguments.length);
    for (let i = 0; i < arguments.length; i++) {
      /* eslint prefer-rest-params: "off" */
      args[i] = arguments[i];
    }
    let topic = args.shift();
    let callback = args.pop() || nop;
    let opts = args.pop();
    if (typeof topic === 'string') {
      topic = [topic];
    }

    if (typeof callback !== 'function') {
      opts = callback;
      callback = nop;
    }

    const invalidTopic = validations.validateTopics(topic);
    if (invalidTopic != undefined) {
      setImmediate(callback, new Error('Invalid topic ' + invalidTopic));
      return this;
    }

    if (this._checkDisconnecting(callback)) {
      return this;
    }

    const unsubscribeProc = (): boolean => {
      const messageId = this._nextId();
      if (messageId == undefined) {
        debug('No messageId left');
        return false;
      }
      const packet: mqttPacket.IUnsubscribePacket = {
        cmd: 'unsubscribe',
        messageId: messageId,
        unsubscriptions: [],
      };

      if (typeof topic === 'string') {
        packet.unsubscriptions = [topic];
      } else if (Array.isArray(topic)) {
        packet.unsubscriptions = topic;
      }

      if (this.options.resubscribe) {
        packet.unsubscriptions.forEach((topic: string): void => {
          delete this._resubscribeTopics[topic];
        });
      }

      if (typeof opts === 'object' && opts.properties) {
        packet.properties = opts.properties;
      }

      this.outgoing[packet.messageId as number] = {
        volatile: true,
        cb: callback,
      };

      debug('unsubscribe: call _sendPacket');
      this._sendPacket(packet);

      return true;
    };

    if (this._storeProcessing || this._storeProcessingQueue.length > 0 || !unsubscribeProc()) {
      this._storeProcessingQueue.push({
        invoke: unsubscribeProc,
        callback: callback,
      });
    }

    return this;
  }

  /**
   * end - close connection
   *
   * @returns {MqttClient} this - for chaining
   * @param {Boolean} force - do not wait for all in-flight messages to be acked
   * @param {Object} opts - added to the disconnect packet
   * @param {Function} cb - called when the client has been closed
   *
   * @api public
   */
  public end(force?: boolean | {} | ErrorOnlyCallback, opts?: {} | ErrorOnlyCallback, cb?: ErrorOnlyCallback): this {
    if (force == undefined || typeof force !== 'boolean') {
      cb = opts as any;
      opts = force as any;
      force = false;
      if (typeof opts !== 'object') {
        cb = opts as any;
        opts = {};
        if (typeof cb !== 'function') {
          cb = undefined;
        }
      }
    }

    if (typeof opts !== 'object') {
      cb = opts as any;
      opts = undefined;
    }

    debug('end :: force=%s opts=%o cb?=%s', force, opts, !!cb);
    cb = cb || nop;

    const closeStores = (): void => {
      debug('end :: closeStores: closing incoming and outgoing stores');
      this.disconnected = true;
      this.incomingStore.close((e1?: Error): void => {
        this.outgoingStore.close((e2?: Error): void => {
          debug('end :: closeStores: emitting end');
          this.emit('end');
          if (cb) {
            debug('end :: closeStores: invoking callback with args');
            cb(e1 || e2);
          }
        });
      });
      if (this._deferredReconnect) {
        this._deferredReconnect();
      }
    };

    const finish = (): void => {
      // defer closesStores of an I/O cycle,
      // just to make sure things are
      // ok for websockets
      debug('end :: (%s) :: finish :: calling _cleanUp with force %s', this.options.clientId, force);
      this._cleanUp(
        force as boolean,
        (): void => {
          // I think this is being called twice.
          debug('end :: finish :: calling process.nextTick on closeStores');
          // const boundProcess = nextTick.bind(null, closeStores)
          process.nextTick(closeStores.bind(this));
        },
        opts
      );
    };

    if (this.disconnecting) {
      cb();
      return this;
    }

    this._clearReconnect();

    this.disconnecting = true;

    if (!force && Object.keys(this.outgoing).length > 0) {
      // wait 10ms, just to be sure we received all of it
      debug('end :: (%s) :: calling finish in 10ms once outgoing is empty', this.options.clientId);
      this.once('outgoingEmpty', setTimeout.bind(null, finish, 10));
    } else {
      debug('end :: (%s) :: immediately calling finish', this.options.clientId);
      finish();
    }
    return this;
  }

  /**
   * removeOutgoingMessage - remove a message in outgoing store
   * the outgoing callback will be called withe Error('Message removed') if the message is removed
   *
   * @param {Number} messageId - messageId to remove message
   * @return {MqttClient} this - for chaining
   * @api public
   *
   * @example client.removeOutgoingMessage(client.getLastAllocated());
   */
  public removeOutgoingMessage(messageId: number): void {
    const cb = this.outgoing[messageId]?.cb;
    delete this.outgoing[messageId];
    this.outgoingStore.del({ messageId: messageId }, (): void => {
      if (cb) {
        cb(new Error('Message removed'));
      }
    });
  }

  /**
   * reconnect - connect again using the same options as connect()
   *
   * @param {Object} [opts] - optional reconnect options, includes:
   *    {Store} incomingStore - a store for the incoming packets
   *    {Store} outgoingStore - a store for the outgoing packets
   *    if opts is not given, current stores are used
   * @return {MqttClient} this - for chaining
   *
   * @api public
   */
  public reconnect(opts: { incomingStore?: Store; outgoingStore?: Store }) {
    debug('client reconnect');
    const f = (): void => {
      if (opts) {
        this.options.incomingStore = opts.incomingStore;
        this.options.outgoingStore = opts.outgoingStore;
      } else {
        this.options.incomingStore = undefined;
        this.options.outgoingStore = undefined;
      }
      this.incomingStore = this.options.incomingStore || new Store();
      this.outgoingStore = this.options.outgoingStore || new Store();
      this.disconnecting = false;
      this.disconnected = false;
      this._deferredReconnect = undefined;
      this._reconnect();
    };

    if (this.disconnecting && !this.disconnected) {
      this._deferredReconnect = f;
    } else {
      f();
    }
    return this;
  }

  /**
   * _reconnect - implement reconnection
   * @api private
   */
  private _reconnect() {
    debug('_reconnect: emitting reconnect to client');
    this.emit('reconnect');
    if (this.connected) {
      this.end(() => {
        this._setupStream();
      });
      debug('client already connected. disconnecting first.');
    } else {
      debug('_reconnect: calling _setupStream');
      this._setupStream();
    }
  }

  /**
   * _setupReconnect - setup reconnect timer
   */
  private _setupReconnect() {
    if (!this.disconnecting && !this.reconnectTimer && this.options.reconnectPeriod && this.options.reconnectPeriod > 0) {
      if (!this.reconnecting) {
        debug('_setupReconnect :: emit `offline` state');
        this.emit('offline');
        debug('_setupReconnect :: set `reconnecting` to `true`');
        this.reconnecting = true;
      }
      debug('_setupReconnect :: setting reconnectTimer for %d ms', this.options.reconnectPeriod);
      this.reconnectTimer = setInterval((): void => {
        debug('reconnectTimer :: reconnect triggered!');
        this._reconnect();
      }, this.options.reconnectPeriod);
    } else {
      debug('_setupReconnect :: doing nothing...');
    }
  }

  /**
   * _clearReconnect - clear the reconnect timer
   */
  private _clearReconnect() {
    debug('_clearReconnect : clearing reconnect timer');
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * _cleanUp - clean up on connection end
   * @api private
   */
  private _cleanUp(forced?: boolean, done?: (err?: Error) => void, opts?: any) {
    if (done) {
      debug('_cleanUp :: done callback provided for on stream close');
      this.stream.on('close', done);
    }

    debug('_cleanUp :: forced? %s', forced);
    if (forced) {
      if (this.options.reconnectPeriod === 0 && this.options.clean) {
        flush(this.outgoing);
      }
      debug('_cleanUp :: (%s) :: destroying stream', this.options.clientId);
      this.stream.destroy();
    } else {
      const packet = { cmd: 'disconnect', ...opts };
      debug('_cleanUp :: (%s) :: call _sendPacket with disconnect packet', this.options.clientId);
      this._sendPacket(packet, setImmediate.bind(null, this.stream.end.bind(this.stream)));
    }

    if (!this.disconnecting) {
      debug('_cleanUp :: client not disconnecting. Clearing and resetting reconnect.');
      this._clearReconnect();
      this._setupReconnect();
    }

    if (this.pingTimer != undefined) {
      debug('_cleanUp :: clearing pingTimer');
      this.pingTimer.clear();
      this.pingTimer = undefined;
    }

    if (done && !this.connected) {
      debug('_cleanUp :: (%s) :: removing stream `done` callback `close` listener', this.options.clientId);
      this.stream.removeListener('close', done);
      done();
    }
  }

  /**
   * _sendPacket - send or queue a packet
   * @param {Object} packet - packet options
   * @param {Function} cb - callback when the packet is sent
   * @param {Function} cbStorePut - called when message is put into outgoingStore
   * @api private
   */
  private _sendPacket(packet: mqttPacket.Packet, cb?: SendPacketCompleteCallback, cbStorePut?: StorePutCompleteCallback): void {
    debug('_sendPacket :: (%s) ::  start', this.options.clientId);
    cbStorePut = cbStorePut || nop;
    cb = cb || nop;

    const err = applyTopicAlias(this, packet);
    if (err) {
      cb(err);
      return;
    }

    if (!this.connected) {
      // allow auth packets to be sent while authenticating with the broker (mqtt5 enhanced auth)
      if (packet.cmd === 'auth') {
        this._shiftPingInterval();
        sendPacket(this, packet, cb);
        return;
      }

      debug('_sendPacket :: client not connected. Storing packet offline.');
      this._storePacket(packet, cb, cbStorePut);
      return;
    }

    // When sending a packet, reschedule the ping timer
    this._shiftPingInterval();

    switch (packet.cmd) {
      case 'publish':
        break;
      case 'pubrel':
        storeAndSend(this, packet, cb, cbStorePut);
        return;
      default:
        sendPacket(this, packet, cb);
        return;
    }

    switch (packet.qos) {
      case 2:
      case 1:
        storeAndSend(this, packet, cb, cbStorePut);
        break;
      /**
       * no need of case here since it will be caught by default
       * and jshint comply that before default it must be a break
       * anyway it will result in -1 evaluation
       */
      case 0:
      /* falls through */
      default:
        sendPacket(this, packet, cb);
        break;
    }
    debug('_sendPacket :: (%s) ::  end', this.options.clientId);
  }

  /**
   * _storePacket - queue a packet
   * @param {Object} packet - packet options
   * @param {Function} cb - callback when the packet is sent
   * @param {Function} cbStorePut - called when message is put into outgoingStore
   * @api private
   */
  private _storePacket(packet: mqttPacket.Packet, cb: SendPacketCompleteCallback, cbStorePut?: StorePutCompleteCallback) {
    debug('_storePacket :: packet: %o', packet);
    debug('_storePacket :: cb? %s', !!cb);
    cbStorePut = cbStorePut || nop;

    let storePacket = packet;
    if (storePacket.cmd === 'publish') {
      // The original packet is for sending.
      // The cloned storePacket is for storing to resend on reconnect.
      // Topic Alias must not be used after disconnected.
      storePacket = clone(packet);
      const err = removeTopicAliasAndRecoverTopicName(this, storePacket as mqttPacket.IPublishPacket);
      if (err) {
        return cb && cb(err);
      }
    }
    // check that the packet is not a qos of 0, or that the command is not a publish
    if ((((storePacket as any).qos || 0) === 0 && this.queueQoSZero) || storePacket.cmd !== 'publish') {
      this.queue.push({ packet: storePacket, cb: cb });
    } else if (storePacket.qos > 0) {
      const innerCallback = this.outgoing[storePacket.messageId as number]?.cb;
      this.outgoingStore.put(storePacket, (err?: Error): void => {
        if (err) {
          if (innerCallback) {
            innerCallback(err);
          }
        } else {
          if (cbStorePut) {
            cbStorePut();
          }
        }
      });
    } else if (cb) {
      cb(new Error('No connection to broker'));
    }
  }

  /**
   * _setupPingTimer - setup the ping timer
   *
   * @api private
   */
  private _setupPingTimer() {
    debug('_setupPingTimer :: keepalive %d (seconds)', this.options.keepalive);

    if (!this.pingTimer && this.options.keepalive) {
      this.pingResp = true;
      this.pingTimer = reInterval((): void => {
        this._checkPing();
      }, this.options.keepalive * 1000);
    }
  }

  /**
   * _shiftPingInterval - reschedule the ping interval
   *
   * @api private
   */
  private _shiftPingInterval() {
    if (this.pingTimer && this.options.keepalive && this.options.reschedulePings) {
      this.pingTimer.reschedule(this.options.keepalive * 1000);
    }
  }
  /**
   * _checkPing - check if a pingresp has come back, and ping the server again
   *
   * @api private
   */
  private _checkPing() {
    debug('_checkPing :: checking ping...');
    if (this.pingResp) {
      debug('_checkPing :: ping response received. Clearing flag and sending `pingreq`');
      this.pingResp = false;
      this._sendPacket({ cmd: 'pingreq' });
    } else {
      // do a forced cleanup since socket will be in bad shape
      debug('_checkPing :: calling _cleanUp with force true');
      this._cleanUp(true);
    }
  }

  /**
   * _handlePingresp - handle a pingresp
   *
   * @api private
   */
  private _handlePingresp(_packet: mqttPacket.Packet): void {
    this.pingResp = true;
  }

  /**
   * _handleConnack
   *
   * @param {Object} packet
   * @api private
   */
  private _handleConnack(packet: mqttPacket.IConnackPacket): void {
    debug('_handleConnack');
    const options = this.options;
    const version = options.protocolVersion;
    const rc: number | undefined = version === 5 ? packet.reasonCode : packet.returnCode;

    clearTimeout(this.connackTimer);
    delete this.topicAliasSend;

    if (packet.properties) {
      if (packet.properties.topicAliasMaximum) {
        if (packet.properties.topicAliasMaximum > 0xffff) {
          this.emit('error', new Error('topicAliasMaximum from broker is out of range'));
          return;
        }
        if (packet.properties.topicAliasMaximum > 0) {
          this.topicAliasSend = new TopicAliasSend(packet.properties.topicAliasMaximum);
        }
      }
      if (packet.properties.serverKeepAlive && options.keepalive) {
        options.keepalive = packet.properties.serverKeepAlive;
        this._shiftPingInterval();
      }
      if (packet.properties.maximumPacketSize) {
        if (!options.properties) {
          options.properties = {};
        }
        options.properties.maximumPacketSize = packet.properties.maximumPacketSize;
      }
    }

    if (rc === undefined || rc === 0) {
      this.reconnecting = false;
      this._onConnect(packet);
    } else if (rc > 0) {
      const err = new Error('Connection refused: ' + errors[rc]);
      (err as any).code = rc;
      this.emit('error', err);
    }
  }

  private _handleAuth(packet: any): void {
    const options = this.options;
    const version = options.protocolVersion;
    const rc: number = version === 5 ? (packet.reasonCode as number) : (packet.returnCode as number);

    if (version !== 5) {
      const err = new Error('Protocol error: Auth packets are only supported in MQTT 5. Your version:' + version);
      (err as any).code = rc;
      this.emit('error', err);
      return;
    }

    this.handleAuth(packet, (err?: Error, packet?: mqttPacket.Packet): void => {
      if (err) {
        this.emit('error', err);
        return;
      }

      if (rc === 24) {
        this.reconnecting = false;
        this._sendPacket(packet as mqttPacket.Packet);
      } else {
        const error = new Error('Connection refused: ' + errors[rc]);
        (err as any).code = rc;
        this.emit('error', error);
      }
    });
  }

  /**
   * @param packet the packet received by the broker
   * @return the auth packet to be returned to the broker
   * @api public
   */
  public handleAuth(_packet: any, callback: (err?: Error, packet?: mqttPacket.Packet) => void): void {
    callback();
  }

  /**
   * _handlePublish
   *
   * @param {Object} packet
   * @api private
   */
  /*
those late 2 case should be rewrite to comply with coding style:

case 1:
case 0:
  // do not wait sending a puback
  // no callback passed
  if (1 === qos) {
    this._sendPacket({
      cmd: 'puback',
      messageId: messageId
    });
  }
  // emit the message event for both qos 1 and 0
  this.emit('message', topic, message, packet);
  this.handleMessage(packet, done);
  break;
default:
  // do nothing but every switch mus have a default
  // log or throw an error about unknown qos
  break;

for now i just suppressed the warnings
*/
  private _handlePublish(packet: mqttPacket.IPublishPacket, done: (err?: Error) => void): void {
    debug('_handlePublish: packet %o', packet);
    done = done || nop;
    let topic = packet.topic.toString();
    const message = packet.payload;
    const qos = packet.qos;
    const messageId = packet.messageId;
    const options = this.options;
    const validReasonCodes = [0, 16, 128, 131, 135, 144, 145, 151, 153];
    if (this.options.protocolVersion === 5) {
      let alias;
      if (packet.properties) {
        alias = packet.properties.topicAlias;
      }
      if (alias != undefined) {
        if (topic.length === 0) {
          if (alias > 0 && alias <= 0xffff) {
            const gotTopic = this.topicAliasRecv!.getTopicByAlias(alias);
            if (gotTopic) {
              topic = gotTopic;
              debug('_handlePublish :: topic complemented by alias. topic: %s - alias: %d', topic, alias);
            } else {
              debug('_handlePublish :: unregistered topic alias. alias: %d', alias);
              this.emit('error', new Error('Received unregistered Topic Alias'));
              return;
            }
          } else {
            debug('_handlePublish :: topic alias out of range. alias: %d', alias);
            this.emit('error', new Error('Received Topic Alias is out of range'));
            return;
          }
        } else {
          if (this.topicAliasRecv!.put(topic, alias)) {
            debug('_handlePublish :: registered topic: %s - alias: %d', topic, alias);
          } else {
            debug('_handlePublish :: topic alias out of range. alias: %d', alias);
            this.emit('error', new Error('Received Topic Alias is out of range'));
            return;
          }
        }
      }
    }
    debug('_handlePublish: qos %d', qos);
    switch (qos) {
      case 2: {
        options.customHandleAcks!(topic, message, packet, (error?: Error, code?: number): void => {
          if (error != undefined && !(error instanceof Error)) {
            code = error;
            error = undefined;
          }
          if (error) {
            this.emit('error', error);
            return;
          }
          if (validReasonCodes.indexOf(code as number) === -1) {
            this.emit('error', new Error('Wrong reason code for pubrec'));
            return;
          }
          if (code) {
            this._sendPacket({ cmd: 'pubrec', messageId: messageId, reasonCode: code }, done);
          } else {
            this.incomingStore.put(packet, (): void => {
              this._sendPacket({ cmd: 'pubrec', messageId: messageId }, done);
            });
          }
        });
        break;
      }
      case 1: {
        // emit the message event
        options.customHandleAcks!(topic, message, packet, (error?: Error, code?: number): void => {
          if (error != undefined && !(error instanceof Error)) {
            code = error;
            error = undefined;
          }
          if (error) {
            this.emit('error', error);
            return;
          }
          if (validReasonCodes.indexOf(code!) === -1) {
            this.emit('error', new Error('Wrong reason code for puback'));
            return;
          }
          if (!code) {
            this.emit('message', topic, message, packet);
          }
          this.handleMessage(packet, (err?: Error): void => {
            if (err) {
              if (done) {
                done(err);
              }
            } else {
              this._sendPacket({ cmd: 'puback', messageId: messageId, reasonCode: code }, done);
            }
          });
        });
        break;
      }
      case 0:
        // emit the message event
        this.emit('message', topic, message, packet);
        this.handleMessage(packet, done);
        break;
      default:
        // do nothing
        debug('_handlePublish: unknown QoS. Doing nothing.');
        // log or throw an error about unknown qos
        break;
    }
  }

  /**
   * Handle messages with backpressure support, one at a time.
   * Override at will.
   *
   * @param mqttPacket.Packet packet the packet
   * @param Function callback call when finished
   * @api public
   */
  public handleMessage(_packet: mqttPacket.Packet, callback: (err?: Error) => void): void {
    callback();
  }

  /**
   * _handleAck
   *
   * @param {Object} packet
   * @api private
   */

  private _handleAck(
    packet:
      | mqttPacket.IPubackPacket
      | mqttPacket.IPubcompPacket
      | mqttPacket.ISubackPacket
      | mqttPacket.IUnsubackPacket
      | mqttPacket.IPubrecPacket
  ): void {
    /* eslint no-fallthrough: "off" */
    const messageId: number = packet.messageId as number;
    const type = packet.cmd;
    const cb = this.outgoing[messageId]?.cb;
    let err;

    if (!cb || cb === nop) {
      debug('_handleAck :: Server sent an ack in error. Ignoring.');
      // Server sent an ack in error, ignore it.
      return;
    }

    // Process
    debug('_handleAck :: packet type', type);
    switch (type) {
      case 'pubcomp':
      // same thing as puback for QoS 2
      case 'puback':
        {
          const pubackRC: number = packet.reasonCode as number;
          // Callback - we're done
          if (pubackRC && pubackRC > 0 && pubackRC !== 16) {
            err = new Error('Publish error: ' + errors[pubackRC]);
            (err as any).code = pubackRC;
            cb(err, packet);
          }
          this.outgoingStore.del(packet, cb);
          if (messageId) {
            this.messageIdProvider.deallocate(messageId);
            delete this.outgoing[messageId];
          }
          this._invokeStoreProcessingQueue();
        }
        break;
      case 'pubrec': {
        const response: mqttPacket.IPubrelPacket = {
          cmd: 'pubrel',
          messageId: messageId,
        };
        const pubrecRC = packet.reasonCode;

        if (pubrecRC && pubrecRC > 0 && pubrecRC !== 16) {
          err = new Error('Publish error: ' + errors[pubrecRC]);
          (err as any).code = pubrecRC;
          cb(err, packet);
        } else {
          this._sendPacket(response);
        }
        break;
      }
      case 'suback': {
        delete this.outgoing[messageId];
        this.messageIdProvider.deallocate(messageId);
        for (let grantedI = 0; grantedI < packet.granted.length; grantedI++) {
          if (((packet.granted[grantedI] as number) & 0x80) !== 0) {
            // TODO: packet.granted could be an array of objects, so casting to number isn't quite correct here.
            // suback with Failure status
            const topics = this.messageIdToTopic[messageId];
            if (topics) {
              topics.forEach((topic: string): void => {
                delete this._resubscribeTopics[topic];
              });
            }
          }
        }
        this._invokeStoreProcessingQueue();
        cb(undefined, packet);
        break;
      }
      case 'unsuback': {
        delete this.outgoing[messageId];
        this.messageIdProvider.deallocate(messageId);
        this._invokeStoreProcessingQueue();
        cb(undefined);
        break;
      }
      default:
        this.emit('error', new Error('unrecognized packet type'));
    }

    if (this.disconnecting && Object.keys(this.outgoing).length === 0) {
      this.emit('outgoingEmpty');
    }
  }

  /**
   * _handlePubrel
   *
   * @param {Object} packet
   * @api private
   */
  private _handlePubrel(packet: mqttPacket.IPubrelPacket, callback: (err?: Error) => void): void {
    debug('handling pubrel packet');
    callback = callback || nop;
    const messageId = packet.messageId;

    const comp: mqttPacket.IPubcompPacket = { cmd: 'pubcomp', messageId: messageId };

    this.incomingStore.get(packet, (err?: Error, pub?: mqttPacket.IPublishPacket): void => {
      if (!err && pub) {
        // TODO: What if !err and !pub. Should we throw?
        this.emit('message', pub.topic, pub.payload, pub);
        this.handleMessage(pub, (err?: Error): void => {
          if (err) {
            return callback(err);
          }
          this.incomingStore.del(pub, nop);
          this._sendPacket(comp, callback);
        });
      } else {
        this._sendPacket(comp, callback);
      }
    });
  }

  /**
   * _handleDisconnect
   *
   * @param {Object} packet
   * @api private
   */
  private _handleDisconnect(packet: mqttPacket.IDisconnectPacket): void {
    this.emit('disconnect', packet);
  }

  /**
   * _nextId
   * @return unsigned int
   */
  private _nextId() {
    return this.messageIdProvider.allocate();
  }

  /**
   * getLastMessageId
   * @return unsigned int
   */
  public getLastMessageId() {
    return this.messageIdProvider.getLastAllocated();
  }

  /**
   * _resubscribe
   * @api private
   */
  private _resubscribe() {
    debug('_resubscribe');
    const _resubscribeTopicsKeys: string[] = Object.keys(this._resubscribeTopics);
    if (
      !this._firstConnection &&
      (this.options.clean || (this.options.protocolVersion === 5 && !this.connackPacket!.sessionPresent)) &&
      _resubscribeTopicsKeys.length > 0
    ) {
      if (this.options.resubscribe) {
        if (this.options.protocolVersion === 5) {
          debug('_resubscribe: protocolVersion 5');
          for (let topicI = 0; topicI < _resubscribeTopicsKeys.length; topicI++) {
            const resubscribeTopic: { [topic: string]: any; resubscribe?: boolean } = {};
            resubscribeTopic[_resubscribeTopicsKeys[topicI] as string] =
              this._resubscribeTopics[_resubscribeTopicsKeys[topicI] as string];
            resubscribeTopic.resubscribe = true;
            this.subscribe(resubscribeTopic, { properties: resubscribeTopic[_resubscribeTopicsKeys[topicI] as string].properties });
          }
        } else {
          this._resubscribeTopics.resubscribe = true;
          this.subscribe(this._resubscribeTopics);
        }
      } else {
        this._resubscribeTopics = {};
      }
    }

    this._firstConnection = false;
  }

  /**
   * _onConnect
   *
   * @api private
   */
  private _onConnect(packet: mqttPacket.IConnackPacket) {
    debug('_onConnect');
    if (this.disconnected) {
      debug('emitting connect');
      this.emit('connect', packet);
      return;
    }

    debug('connect handling');

    this.connackPacket = packet;
    this.messageIdProvider.clear();
    this._setupPingTimer();

    this.connected = true;

    const startStreamProcess = (): void => {
      let outStore: Readable | undefined = this.outgoingStore.createStream();

      const clearStoreProcessing = (): void => {
        this._storeProcessing = false;
        this._packetIdsDuringStoreProcessing = {};
      };

      outStore!.on('error', (err: Error): void => {
        clearStoreProcessing();
        this._flushStoreProcessingQueue();
        this.removeListener('close', remove);
        this.emit('error', err);
      });

      const remove = (): void => {
        if (outStore) {
          outStore.destroy();
          outStore = undefined;
        }
        this._flushStoreProcessingQueue();
        clearStoreProcessing();
      };
      this.once('close', remove);

      const storeDeliver = (): void => {
        // edge case, we wrapped this twice
        if (!outStore) {
          return;
        }
        this._storeProcessing = true;

        const packet = outStore.read(1);

        if (!packet) {
          // read when data is available in the future
          outStore.once('readable', storeDeliver);
          return;
        }

        // Skip already processed store packets
        if (this._packetIdsDuringStoreProcessing[packet.messageId as number]) {
          storeDeliver();
          return;
        }

        // Avoid unnecessary stream read operations when disconnected
        if (!this.disconnecting && !this.reconnectTimer) {
          const innerCallback = this.outgoing[packet.messageId]?.cb;
          this.outgoing[packet.messageId] = {
            volatile: false,
            cb: (err?: Error, status?: any): void => {
              // Ensure that the original callback passed in to publish gets invoked
              if (innerCallback) {
                innerCallback(err, status);
              }

              storeDeliver();
            },
          };
          this._packetIdsDuringStoreProcessing[packet.messageId] = true;
          if (this.messageIdProvider.register(packet.messageId)) {
            this._sendPacket(packet);
          } else {
            debug('messageId: %d has already used.', packet.messageId);
          }
        } else if (outStore.destroy) {
          outStore.destroy();
        }
      };

      outStore.on('end', (): void => {
        console.log('outStore.on(end');
        let allProcessed = true;
        for (const id in this._packetIdsDuringStoreProcessing) {
          if (!this._packetIdsDuringStoreProcessing[id]) {
            allProcessed = false;
            break;
          }
        }
        if (allProcessed) {
          clearStoreProcessing();
          this.removeListener('close', remove);
          this._invokeAllStoreProcessingQueue();
          this.emit('connect', packet);
        } else {
          startStreamProcess();
        }
      });
      console.log('outStore.storeDeliver');
      storeDeliver();
    };
    // start flowing
    startStreamProcess();
  }

  private _invokeStoreProcessingQueue() {
    if (this._storeProcessingQueue.length > 0) {
      const f = this._storeProcessingQueue[0];
      if (f && f.invoke()) {
        this._storeProcessingQueue.shift();
        return true;
      }
    }
    return false;
  }

  private _invokeAllStoreProcessingQueue() {
    while (this._invokeStoreProcessingQueue()) {
      /* empty */
    }
  }

  private _flushStoreProcessingQueue() {
    for (const f of this._storeProcessingQueue) {
      if (f.cbStorePut) f.cbStorePut(new Error('Connection closed'));
      if (f.callback) f.callback(new Error('Connection closed'));
    }
    this._storeProcessingQueue.splice(0);
  }
}

exports.MqttClient = MqttClient;