var util = require('./util');
var EventEmitter = require('eventemitter3');
var WebSocket = require('ws');

/**
 * An abstraction on top of WebSockets and XHR streaming to provide fastest
 * possible connection for peers.
 */
function Socket(secure, host, port, path, key, origin) {
  if (!(this instanceof Socket)) return new Socket(secure, host, port, path, key, origin);

  EventEmitter.call(this);

  // Disconnected manually.
  this.disconnected = false;
  this._queue = [];

  var httpProtocol = secure ? 'https://' : 'http://';
  var wsProtocol = secure ? 'wss://' : 'ws://';
  this._httpUrl = httpProtocol + host + ':' + port + path + key;
  this._wsUrl = wsProtocol + host + ':' + port + path + 'peerjs?key=' + key;
  this._origin = origin || location.origin;
}

util.inherits(Socket, EventEmitter);


/** Check in with ID or get one from server. */
Socket.prototype.start = function(id, token) {
  this.id = id;

  this._httpUrl += '/' + id + '/' + token;
  this._wsUrl += '&id=' + id + '&token=' + token;

  this._startXhrStream();
  this._startWebSocket();
}


/** Start up websocket communications. */
Socket.prototype._startWebSocket = function(id) {
  var self = this;

  if (this._socket) {
    return;
  }

  var options = {};
  if (this._origin) {
    options.origin = this._origin;
  }

  this._socket = new WebSocket(this._wsUrl, options);

  this._socket.on('message', function (data) {
    try {
      data = JSON.parse(data);
    } catch(e) {
      util.log('Invalid server message', data);
      return;
    }
    self.emit('message', data);
  });

  // Take care of the queue of connections if necessary and make sure Peer knows
  // socket is open.
  this._socket.on('open', function () {
    if (self._timeout) {
      clearTimeout(self._timeout);
      setTimeout(function(){
        self._http = null;
      }, 5000);
    }
    if (util.supportsKeepAlive) {
      self._setWSTimeout();
    }
    self._sendQueuedMessages();
    util.log('Socket open');
  });

  this._socket.on('error', function (err) {
    util.error('WS error code '+err.code);
  });

  this._socket.on('close', function (code, msg) {
      util.error("WS closed with code "+msg.code);
      if(!self.disconnected) {
        self._startXhrStream();
      }
  });
}

/** Start XHR streaming. */
Socket.prototype._startXhrStream = function(n) {
  try {
    var self = this;
    var url = this._httpUrl + '/id?i=' + this._http._streamIndex;
    var options = { method: 'post', timeout: 25000 };
    if (this._origin) {
      options.headers = { Origin: this._origin };
    }

    this._http = {};
    this._http._index = 1;
    this._http._streamIndex = n || 0;

    fetch(url, options)
    .then(function (response) {
      if (self._http.old) delete self._http.old;

      if (response.status === 200) {
        return response.text()
      }
    })
    .then(function (text) {
      text && self._handleStream(self._http, text);
    })
    .catch(function (err) {
      self.emit('disconnected');
    });

  } catch(e) {
    util.log('XMLHttpRequest not available; defaulting to WebSockets');
  }
}


/** Handles onreadystatechange response as a stream. */
Socket.prototype._handleStream = function(http, text) {
  // 3 and 4 are loading/done state. All others are not relevant.
  var messages = text.split('\n');

  // Check to see if anything needs to be processed on buffer.
  if (http._buffer) {
    while (http._buffer.length > 0) {
      var index = http._buffer.shift();
      var bufferedMessage = messages[index];
      try {
        bufferedMessage = JSON.parse(bufferedMessage);
      } catch(e) {
        http._buffer.shift(index);
        break;
      }
      this.emit('message', bufferedMessage);
    }
  }

  var message = messages[http._index];
  if (message) {
    http._index += 1;
    // Buffering--this message is incomplete and we'll get to it next time.
    // This checks if the httpResponse ended in a `\n`, in which case the last
    // element of messages should be the empty string.
    if (http._index === messages.length) {
      if (!http._buffer) {
        http._buffer = [];
      }
      http._buffer.push(http._index - 1);
    } else {
      try {
        message = JSON.parse(message);
      } catch(e) {
        util.log('Invalid server message', message);
        return;
      }
      this.emit('message', message);
    }
  }
}

Socket.prototype._setHTTPTimeout = function() {
  var self = this;
  this._timeout = setTimeout(function() {
    var old = self._http;
    if (!self._wsOpen()) {
      self._startXhrStream(old._streamIndex + 1);
      self._http.old = old;
    }
  }, 25000);
}

Socket.prototype._setWSTimeout = function(){
    var self = this;
    this._wsTimeout = setTimeout(function(){
        if(self._wsOpen()){
            self._socket.close();
            util.error('WS timed out');
        }
    }, 45000)
}

/** Is the websocket currently open? */
Socket.prototype._wsOpen = function() {
  return this._socket && this._socket.readyState == 1;
}

/** Send queued messages. */
Socket.prototype._sendQueuedMessages = function() {
  for (var i = 0, ii = this._queue.length; i < ii; i += 1) {
    this.send(this._queue[i]);
  }
}

/** Exposed send for DC & Peer. */
Socket.prototype.send = function(data) {
  if (this.disconnected) {
    return;
  }

  // If we didn't get an ID yet, we can't yet send anything so we should queue
  // up these messages.
  if (!this.id) {
    this._queue.push(data);
    return;
  }

  if (!data.type) {
    this.emit('error', 'Invalid message');
    return;
  }

  var message = JSON.stringify(data);
  if (this._wsOpen()) {
    this._socket.send(message);
  } else if(data.type !== 'PONG') {
    var url = this._httpUrl + '/' + data.type.toLowerCase();
    var options = {
      method: 'post',
      body: message,
      headers: { 'Content-Type': 'application/json' }
    };

    if (this._origin) {
      options.headers.Origin = this._origin;
    }

    fetch(url, options).catch(function (e) {
      console.error(e);
    });
  }
}

Socket.prototype.sendPong = function() {
  if (this._wsOpen()) {
    this.send({type:'PONG'});
    if (this._wsTimeout) {
      clearTimeout(this._wsTimeout);
    }
    this._setWSTimeout();
  }
}

Socket.prototype.close = function() {
  if (!this.disconnected) {
    this.disconnected = true;
    if(this._wsOpen()) {
      this._socket.close();
    }
    if(this._http) {
        this._http.abort();
    }
    clearTimeout(this._timeout);
  }
}

module.exports = Socket;
