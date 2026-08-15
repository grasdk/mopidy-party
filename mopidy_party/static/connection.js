// Modular reading of the config value, setting it for both JS and CSS.
var partyConnectionTimeoutMeta = document.querySelector('meta[name="party-connection-timeout-ms"]');
window.PARTY_CONNECTION_TIMEOUT_MS = parseInt(
  (partyConnectionTimeoutMeta && partyConnectionTimeoutMeta.getAttribute('content')) || '120000',
  10
) || 120000;

if (document && document.documentElement) {
  document.documentElement.style.setProperty(
    '--party-connection-timeout-ms',
    window.PARTY_CONNECTION_TIMEOUT_MS + 'ms'
  );
}

// Factory that creates connection handlers which manage connectivity state
// and communicate that state to the UI. This keeps the logic modular while
// avoiding leaking controller-scoped variables into the global scope.
window.createConnectionHandlers = function ($scope, $timeout, $http, mopidy) {
  var reconnectionTimeoutTimer = null;
  var reconnectionAttemptTimer = null;
  var connectionTimeoutMs = window.PARTY_CONNECTION_TIMEOUT_MS;

  function startReconnectionTimeout() {
    cancelReconnectionTimeout();
    cancelReconnectionAttempt();
    $scope.reconnectionTimeoutExpired = false;
    $scope.connectionOverlayVisible = true;
    $scope.connectionOverlayTimeoutReached = false;
    $scope.connectionOverlayMessage = $scope.connectionErrorMessage || 'Connection lost. Attempting to reconnect.';
    reconnectionTimeoutTimer = $timeout(function () {
      if (!$scope.connectionLost) {
        return;
      }
      attemptReconnect().catch(function () {
        if ($scope.connectionLost) {
          abandonConnectionAndCleanup();
        }
      });
    }, connectionTimeoutMs);
  }

  function cancelReconnectionTimeout() {
    if (reconnectionTimeoutTimer) {
      $timeout.cancel(reconnectionTimeoutTimer);
      reconnectionTimeoutTimer = null;
    }
  }

  function cancelReconnectionAttempt() {
    if (reconnectionAttemptTimer) {
      $timeout.cancel(reconnectionAttemptTimer);
      reconnectionAttemptTimer = null;
    }
  }

  function scheduleReconnectionAttempt() {
    cancelReconnectionAttempt();
    reconnectionAttemptTimer = $timeout(function () {
      if (!$scope.connectionLost) {
        return;
      }
      attemptReconnect().catch(function () {
        if ($scope.connectionLost) {
          scheduleReconnectionAttempt();
        }
      });
    }, 3000);
  }

  function abandonConnectionAndCleanup() {
    cancelReconnectionTimeout();
    cancelReconnectionAttempt();
    $scope.reconnectionTimeoutExpired = true;
    $scope.connectionOverlayVisible = true;
    $scope.connectionOverlayTimeoutReached = true;
    $scope.connectionOverlayMessage = $scope.connectionErrorMessage || 'Unable to reconnect to the Mopidy server.';
    mopidy.close();
    mopidy.off();
    mopidy = null;
    $scope.$applyAsync();
  }

  function attemptReconnect() {
    if (!$scope.connectionLost) {
      return Promise.resolve();
    }

    return mopidy.playback.getState().then(function () {
      connectionConfirmed();
    }).catch(function () {
      return $http.get('/party/config?key=max_results').then(function () {
        connectionConfirmed();
      });
    });
  }

  function connectionLost(message) {
    var wasAlreadyLost = $scope.connectionLost;
    $scope.connectionLost = true;
    $scope.connectionErrorMessage = message || 'Unable to contact the backend.';
    $scope.connectionOverlayVisible = true;
    $scope.connectionOverlayTimeoutReached = false;
    $scope.connectionOverlayMessage = $scope.connectionErrorMessage;
    if (!wasAlreadyLost) {
      $scope.reconnectionTimeoutExpired = false;
      startReconnectionTimeout();
    }
    attemptReconnect().catch(function () {
      if ($scope.connectionLost) {
        scheduleReconnectionAttempt();
      }
    });
    $scope.$applyAsync();
  }

  function connectionConfirmed() {
    cancelReconnectionTimeout();
    cancelReconnectionAttempt();
    $scope.connectionLost = false;
    $scope.reconnectionTimeoutExpired = false;
    $scope.connectionErrorMessage = '';
    $scope.connectionOverlayVisible = false;
    $scope.connectionOverlayTimeoutReached = false;
    $scope.connectionOverlayMessage = '';
    $scope.$applyAsync();
  }

  mopidy.on('state:online', function () {
    connectionConfirmed();
  });

  mopidy.on('state:offline', function () {
    connectionLost('Connection lost. Attempting to reconnect.');
  });

  return {
    connectionLost: connectionLost,
    connectionConfirmed: connectionConfirmed,
    attemptReconnect: attemptReconnect
  };
};