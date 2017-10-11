'use strict'

import Server from './server'
import JIFHandler from '../jif-handler'
import HTTPSocketWrapper from './socket-wrapper'
import * as HTTPStatus from 'http-status'
import { EventEmitter } from 'events'
import MessageDistributor from '../message-distributor'
import { EVENT } from '../../constants'

export default class HTTPConnectionEndpoint extends EventEmitter implements ConnectionEndpoint {

  public isReady: boolean = false
  public description: string = 'HTTP connection endpoint'

  private _options: any
  private _initialised: boolean = false
  private _logger: Logger
  private _authenticationHandler: AuthenticationHandler
  private _permissionHandler: PermissionHandler
  private _messageDistributor: MessageDistributor
  private _dsOptions: DeepstreamConfig
  private _jifHandler: JIFHandler
  private _onSocketMessageBound: Function
  private _onSocketErrorBound: Function
  private _server: Server
  private _logInvalidAuthData: boolean
  private _requestTimeout: number

  constructor (private options: any, private services: DeepstreamServices) {
    super()

    this._options = options
    this._onSocketMessageBound = this._onSocketMessage.bind(this)
    this._onSocketErrorBound = this._onSocketError.bind(this)
  }

  /**
   * Called on initialization with a reference to the instantiating deepstream server.
   *
   * @param {Deepstream} deepstream
   *
   * @public
   * @returns {Void}
   */
  public setDeepstream (deepstream): void {
    this._logger = deepstream.services.logger
    this._authenticationHandler = deepstream.services.authenticationHandler
    this._permissionHandler = deepstream.services.permissionHandler
    this._messageDistributor = deepstream.messageDistributor
    this._dsOptions = deepstream.config
    this._jifHandler = new JIFHandler({ logger: deepstream.services.logger })
  }

  /**
   * Initialise the http server.
   *
   * @throws Will throw if called before `setDeepstream()`.
   *
   * @public
   * @returns {Void}
   */
  public init (): void {
    if (!this._dsOptions) {
      throw new Error('setDeepstream must be called before init()')
    }
    if (this._initialised) {
      throw new Error('init() must only be called once')
    }
    this._initialised = true

    const serverConfig = {
      port: this._getOption('port'),
      host: this._getOption('host'),
      healthCheckPath: this._getOption('healthCheckPath'),
      authPath: this._options.authPath,
      postPath: this._options.postPath,
      getPath: this._options.getPath,
      allowAllOrigins: this._options.allowAllOrigins,
      enableAuthEndpoint: this._options.enableAuthEndpoint
    }
    this._server = new Server(serverConfig, this._logger)

    this._server.on('auth-message', this._onAuthMessage.bind(this))
    this._server.on('post-message', this._onPostMessage.bind(this))
    this._server.on('get-message', this._onGetMessage.bind(this))

    this._server.on('ready', () => {
      this.isReady = true
      this.emit('ready')
    })

    this._server.start()

    this._logInvalidAuthData = this._getOption('logInvalidAuthData') as boolean
    this._requestTimeout = this._getOption('requestTimeout') as number
    if (this._requestTimeout === undefined) {
      this._requestTimeout = 20000
    }
  }

  /**
   * Get a parameter from the root of the deepstream options if present, otherwise get it from the
   * plugin config.
   *
   * @param {String} option  The name of the option to be fetched
   *
   * @private
   * @returns {Value} value
   */
  private _getOption (option): string | boolean | number {
    const value = this._dsOptions[option]
    if ((value === null || value === undefined) && (this._options[option] !== undefined)) {
      return this._options[option]
    }
    return value
  }

  close () {
    this._server.stop(() => this.emit('close'))
  }

  /**
   * Called for every message that's received
   * from an authenticated socket
   *
   * This method will be overridden by an external class and is used instead
   * of an event emitter to improve the performance of the messaging pipeline
   *
   * @param   {SocketWrapper} socketWrapper
   * @param   {Array}         messages      the parsed messages
   *
   * @public
   *
   * @returns {void}
   */
  public onMessages (socketWrapper: SimpleSocketWrapper, messages: Array<Message>): void { // eslint-disable-line
  }

  /**
   * Handle a message to the authentication endpoint (for token generation).
   *
   * Passes the entire message to the configured authentication handler.
   *
   * @param   {Object}    authData
   * @param   {Object}    metadata          headers and other connection data
   * @param   {Function}  responseCallback
   *
   * @private
   *
   * @returns {void}
   */
  private _onAuthMessage (authData: object, metadata: object, responseCallback: Function): void {
    this._authenticationHandler.isValidUser(
      metadata,
      authData,
      this._processAuthResult.bind(this, responseCallback, authData)
    )
  }

  /**
   * Handle response from authentication handler relating to an auth request.
   *
   * Builds a response containing the user's userData and token
   *
   * @param   {Function} responseCallback   callback for the entire request
   * @param   {Object}   authData
   * @param   {Boolean}  isAllowed
   * @param   {Object}   data
   *
   * @private
   *
   * @returns {void}
   */
  private _processAuthResult (
    responseCallback: Function,
    authData: object,
    isAllowed: boolean,
    data: { token: string, clientData: object }
  ): void {
    if (isAllowed === true) {
      responseCallback(null, {
        token: data.token,
        clientData: data.clientData
      })
      return
    }

    let error = typeof data === 'string' ? data : 'Invalid authentication data.'

    responseCallback({
      statusCode: HTTPStatus.UNAUTHORIZED,
      message: error
    })

    if (this._logInvalidAuthData === true) {
      error += `: ${JSON.stringify(authData)}`
    }

    this._logger.debug(EVENT.INVALID_AUTH_DATA, error)
  }

  /**
   * Handle a message to the POST endpoint
   *
   * Authenticates the message using authData, a token, or OPEN auth if enabled/provided.
   *
   * @param   {Object}    messageData
   * @param   {Object}    metadata          headers and other connection data
   * @param   {Function}  responseCallback
   *
   * @private
   *
   * @returns {void}
   */
  _onPostMessage (
    messageData: { token?: string, authData?: object, body: Array<object> },
    metadata: object,
    responseCallback: Function
  ): void {
    if (!Array.isArray(messageData.body) || messageData.body.length < 1) {
      const error = `Invalid message: the "body" parameter must ${
        messageData.body ? 'be a non-empty array of Objects.' : 'exist.'
      }`
      responseCallback({
        statusCode: HTTPStatus.BAD_REQUEST,
        message: error
      })
      this._logger.debug(
        EVENT.INVALID_MESSAGE,
        JSON.stringify(messageData.body)
      )
      return
    }
    let authData = {}
    if (messageData.authData !== undefined) {
      if (this._options.allowAuthData !== true) {
        const error = 'Authentication using authData is disabled. Try using a token instead.'
        responseCallback({ statusCode: HTTPStatus.BAD_REQUEST, message: error })
        this._logger.debug(
          EVENT.INVALID_AUTH_DATA,
          'Auth rejected because allowAuthData was disabled'
        )
        return
      }
      if (messageData.authData === null || typeof messageData.authData !== 'object') {
        const error = 'Invalid message: the "authData" parameter must be an object'
        responseCallback({ statusCode: HTTPStatus.BAD_REQUEST, message: error })
        this._logger.debug(
          EVENT.INVALID_AUTH_DATA,
          `authData was not an object: ${
            this._logInvalidAuthData === true ? JSON.stringify(messageData.authData) : '-'
          }`
        )
        return
      }
      authData = messageData.authData
    } else if (messageData.token !== undefined) {
      if (typeof messageData.token !== 'string' || messageData.token.length === 0) {
        const error = 'Invalid message: the "token" parameter must be a non-empty string'
        responseCallback({ statusCode: HTTPStatus.BAD_REQUEST, message: error })
        this._logger.debug(
          EVENT.INVALID_AUTH_DATA,
          `auth token was not a string: ${
            this._logInvalidAuthData === true ? messageData.token : '-'
          }`
        )
        return
      }
      authData = Object.assign({}, authData, { token: messageData.token })
    }

    this._authenticationHandler.isValidUser(
      metadata,
      authData,
      this._onMessageAuthResponse.bind(this, responseCallback, messageData)
    )
  }

  /**
   * Create and initialize a new SocketWrapper
   *
   * @param   {Object}   authResponseData
   * @param   {Number}   messageIndex
   * @param   {Array}    messageResults
   * @param   {Function} responseCallback
   * @param   {Timeout}  requestTimeoutId
   *
   * @private
   *
   * @returns {void}
   */
  _createSocketWrapper (
    authResponseData: object,
    messageIndex,
    messageResults,
    responseCallback,
    requestTimeoutId
  ): SocketWrapper {
    const socketWrapper = new HTTPSocketWrapper(
      {}, this._onSocketMessageBound, this._onSocketErrorBound
    )

    socketWrapper.init(
      authResponseData, messageIndex, messageResults, responseCallback, requestTimeoutId
    )
    return socketWrapper
  }

  /**
   * Handle response from authentication handler relating to a POST request.
   *
   * Parses, permissions and distributes the individual messages
   *
   * @param   {Function} responseCallback   callback for the entire request
   * @param   {Object}   authData
   * @param   {Boolean}  isAllowed
   * @param   {Object}   authResponseData
   *
   * @private
   *
   * @returns {void}
   */
  _onMessageAuthResponse (
    responseCallback: Function,
    messageData: { body: Array<object> },
    success: boolean,
    authResponseData: object
  ): void {
    if (success !== true) {
      const error = typeof authResponseData === 'string' ? authResponseData : 'Unsuccessful authentication attempt.'
      responseCallback({
        statusCode: HTTPStatus.UNAUTHORIZED,
        message: error
      })
      return
    }
    const messageCount = messageData.body.length
    const messageResults = new Array(messageCount).fill(null)

    const parseResults = new Array(messageCount)
    for (let messageIndex = 0; messageIndex < messageCount; messageIndex++) {
      const parseResult = this._jifHandler.fromJIF(messageData.body[messageIndex])
      parseResults[messageIndex] = parseResult
      if (!parseResult.success) {
        const message = `Failed to parse JIF object at index ${messageIndex}.`
        responseCallback({
          statusCode: HTTPStatus.BAD_REQUEST,
          message: parseResult.error ? `${message} Reason: ${parseResult.error}` : message
        })
        this._logger.debug(EVENT.MESSAGE_PARSE_ERROR, parseResult.error)
        return
      }
    }

    const requestTimeoutId = setTimeout(
      () => this._onRequestTimeout(responseCallback, messageResults),
      this._requestTimeout
    )

    const dummySocketWrapper = this._createSocketWrapper(authResponseData, null, null, null, null)

    for (let messageIndex = 0; messageIndex < messageCount; messageIndex++) {
      const parseResult = parseResults[messageIndex]
      if (parseResult.done) {
        // Messages such as event emits do not need to wait for a response. However, we need to
        // check that the message was successfully permissioned, so bypass the message-processor.
        this._permissionEventEmit(
          dummySocketWrapper, parseResult.message, messageResults, messageIndex
        )
        // check if a response can be sent immediately
        if (messageIndex === messageCount - 1) {
          HTTPConnectionEndpoint._checkComplete(messageResults, responseCallback, requestTimeoutId)
        }
      } else {
        const socketWrapper = this._createSocketWrapper(
          authResponseData, messageIndex, messageResults, responseCallback, requestTimeoutId
        )

        /*
         * TODO: work out a way to safely enable socket wrapper pooling
         * if (this._socketWrapperPool.length === 0) {
         *   socketWrapper = new HTTPSocketWrapper(
         *     this._onSocketMessageBound,
         *     this._onSocketErrorBound
         *   )
         * } else {
         *   socketWrapper = this._socketWrapperPool.pop()
         * }
         */

        // emit the message
        this.onMessages(socketWrapper, [parseResult.message])
      }
    }
  }

  /**
   * Handle messages from deepstream socketWrappers and inserts message responses into the HTTP
   * response where possible.
   *
   * @param   {Array}     messageResults   array of all results
   * @param   {Number}    index            result index corresponding to socketWrapper
   * @param   {String}    topic
   * @param   {String}    action
   * @param   {Array}    data
   * @param   {Function}  responseCallback
   * @param   {Number}    requestTimeoutId
   *
   * @private
   *
   * @returns {void}
   */
  _onSocketMessage (
    messageResults: Array<JifResult>, index: number, message: Message, responseCallback: Function, requestTimeoutId: NodeJS.Timer
  ): void {
    const parseResult = this._jifHandler.toJIF(message)
    if (!parseResult) {
      const errorMessage = `${message.topic} ${message.action} ${JSON.stringify(message.data)}`
      this._logger.error(EVENT.MESSAGE_PARSE_ERROR, errorMessage)
      return
    }
    if (parseResult.done !== true) {
      return
    }
    if (messageResults[index] === null) {
      messageResults[index] = parseResult.message
      HTTPConnectionEndpoint._checkComplete(messageResults, responseCallback, requestTimeoutId)
    }
  }

  /**
   * Handle errors from deepstream socketWrappers and inserts message rejections into the HTTP
   * response where necessary.
   *
   * @param   {Array}     messageResults   array of all results
   * @param   {Number}    index            result index corresponding to socketWrapper
   * @param   {String}    topic
   * @param   {String}    event
   * @param   {Array}     message
   * @param   {Function}  responseCallback
   * @param   {Number}    requestTimeoutId
   *
   * @private
   *
   * @returns {void}
   */
  _onSocketError (
    messageResults: Array<JifResult>,
    index: number,
    message: Message,
    event: string,
    errorMessage: string,
    responseCallback: Function,
    requestTimeoutId: NodeJS.Timer
  ): void {
    const parseResult = this._jifHandler.errorToJIF(message, event)
    if (parseResult.done && messageResults[index] === null) {
      messageResults[index] = parseResult.message
      HTTPConnectionEndpoint._checkComplete(messageResults, responseCallback, requestTimeoutId)
    }
  }

  /**
   * Check whether any more responses are outstanding and finalize http response if not.
   *
   * @param   {Array}     messageResults   array of all results
   * @param   {Function}  responseCallback
   * @param   {Number}    requestTimeoutId
   *
   * @private
   *
   * @returns {void}
   */
  static _checkComplete (messageResults: Array<JifResult>, responseCallback: Function, requestTimeoutId: NodeJS.Timer): void {
    const messageResult = HTTPConnectionEndpoint.calculateMessageResult(messageResults)
    if (messageResult === null) {
      // insufficient responses received
      return
    }

    clearTimeout(requestTimeoutId)

    responseCallback(null, {
      result: messageResult,
      body: messageResults
    })
  }

  /**
   * Handle request timeout, sending any responses that have already resolved.
   *
   * @param   {Function}  responseCallback
   * @param   {Array}     messageResults   array of all results
   *
   * @private
   *
   * @returns {void}
   */
  _onRequestTimeout (responseCallback: Function, messageResults: Array<JifResult>): void {
    let numTimeouts = 0
    for (let i = 0; i < messageResults.length; i++) {
      if (messageResults[i] === null) {
        messageResults[i] = {
          success: false,
          error: 'Request exceeded timeout before a response was received.',
          // errorTopic: 'connection',
          // errorEvent: EVENT.TIMEOUT
        }
        numTimeouts++
      }
    }
    if (numTimeouts === 0) {
      return
    }

    this._logger.warn(EVENT.TIMEOUT, 'HTTP Request timeout')

    const result = HTTPConnectionEndpoint.calculateMessageResult(messageResults)

    responseCallback(null, {
      result,
      body: messageResults
    })
  }

  /**
   * Calculate the 'result' field in a response depending on how many responses resolved
   * successfully. Can be one of 'SUCCESS', 'FAILURE' or 'PARTIAL SUCCSS'
   *
   * @param   {Array}     messageResults   array of all results
   *
   * @private
   *
   * @returns {void}
   */
  static calculateMessageResult (messageResults: Array<JifResult>): string {
    let numSucceeded = 0
    for (let i = 0; i < messageResults.length; i++) {
      if (!messageResults[i]) {
        // todo: when does this happen
        console.log(messageResults[i])
        return ''
      }
      if (messageResults[i].success) {
        numSucceeded++
      }
    }

    if (numSucceeded === messageResults.length) {
      return 'SUCCESS'
    }
    if (numSucceeded === 0) {
      return 'FAILURE'
    }
    return 'PARTIAL_SUCCESS'
  }

  // eslint-disable-next-line
  _onGetMessage (data, headers, responseCallback) {
    // TODO: implement a GET endpoint that reads the current state of a record
  }

  /**
   * Permission an event emit and capture the response directly
   *
   * @param   {HTTPSocketWrapper} socketWrapper
   * @param   {Object}            parsedMessage
   * @param   {Array}             messageResults  array of all results
   * @param   {Number}            messageIndex
   *
   * @private
   *
   * @returns {void}
   */
  _permissionEventEmit (
    socketWrapper: SocketWrapper,
    parsedMessage: Message,
    messageResults: Array<JifResult>,
    messageIndex: number
  ): void {
    this._permissionHandler.canPerformAction(
      socketWrapper.user,
      parsedMessage,
      this._onPermissionResponse.bind(
        this, socketWrapper, parsedMessage, messageResults, messageIndex
      ),
      socketWrapper.authData,
      socketWrapper
    )
  }

  /**
   * Handle an event emit permission response
   *
   * @param   {HTTPSocketWrapper} socketWrapper
   * @param   {Object}            message
   * @param   {Array}             messageResults  array of all results
   * @param   {Number}            messageIndex
   * @param   {Error}             error
   * @param   {Boolean}           permissioned
   *
   * @private
   *
   * @returns {void}
   */
  _onPermissionResponse (
    socketWrapper: SocketWrapper,
    message: Message,
    messageResults: Array<JifResult>,
    messageIndex: number,
    error: string,
    permissioned: boolean
  ): void {
    if (error !== null) {
      this._options.logger.warn(EVENT.MESSAGE_PERMISSION_ERROR, error.toString())
    }
    if (permissioned !== true) {
      messageResults[messageIndex] = {
        success: false,
        error: 'Message denied. Action \'emit\' is not permitted.',
        // errorEvent: C.EVENT.MESSAGE_DENIED,
        // errorAction: 'emit',
        // errorTopic: 'event'
      }
      return
    }
    messageResults[messageIndex] = { success: true }
    this._messageDistributor.distribute(socketWrapper, message)
  }
}