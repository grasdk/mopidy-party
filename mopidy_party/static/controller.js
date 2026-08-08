'use strict';

// TODO : add a mopidy service designed for angular, to avoid ugly $scope.$apply()...
angular.module('partyApp', [])
  .controller('MainController', function ($scope, $http, $timeout, $window) {

    // Scope variables
    $scope.message = [];
    let messageTimer = null;
    $scope.messageFadingOut = false;
    $scope.messagePosition = { top: '30px', left: '5px' };
    $scope.tracks = [];
    $scope.tracksToLookup = [];
    $scope.maxTracksToLookup = 50; // Will be overwritten later by module config
    $scope.loading = true;
    $scope.maxSongLengthMS = 0; //0 No limit. May be overwritten by module config
    $scope.searching = false;
    $scope.searchingSources = [];
    $scope.submitSymbol = '↵';
    $scope.ready = false;
    $scope.autosubmitTime = 0; //0 No autosubmit. May be overwritten by module config
    let countdownInterval;
    let countdownTime;
    $scope.currentState = {
      paused: false,
      length: 0,
      track: {
        length: 0,
        name: 'Nothing playing, add some songs to get the party going!'
      }
    };
    $scope.sources_blacklist = ['cd', 'file']; // Will be overwritten later by module config
    $scope.sources = ['local'];                // Will be overwritten later by reading mopidy config
    $scope.queuedTrackUris = new Set();
    
    // Get the max tracks to lookup at once from the 'max_results' config value in mopidy.conf
    $http.get('/party/config?key=max_results').then(function success (response) {
      if (response.status == 200) {
        $scope.maxTracksToLookup = response.data;
      }
    }, null);

    // Get the max song length 'max_song_duration' config value in mopidy.conf (minutes)
    $http.get('/party/config?key=max_song_duration').then(function success (response) {
      if (response.status == 200) {
        $scope.maxSongLengthMS = response.data * 60000;
      }
    }, null);

    function parseConfigList(data) {
      return String(data || '')
        .replace(/^['"]|['"]$/g, '')
        .replace(/\\n/g, '\n')
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#'));
    }

    // Get the source blacklist
    $http.get('/party/config?key=source_blacklist').then(function success (response) {
      if (response.status == 200) {
        $scope.sources_blacklist = parseConfigList(response.data);
      }
    }, null);

    // Get the autosubmit time
    $http.get('/party/config?key=autosubmit_time').then(function success (response) {
      if (response.status == 200) {
        $scope.autosubmitTime = response.data;
      } 
    }, null);

    var mopidy = new Mopidy();

    mopidy.on('state:online', function () {
      mopidy.playback
        .getCurrentTrack()
        .then(function (track) {
          if (track) {
            $scope.currentState.track = track;
          }
          return mopidy.playback.getState();
        })
        .then(function (state) {
          $scope.currentState.paused = (state === 'paused');
          return mopidy.tracklist.getLength();
        })
        .then(function (length) {
          $scope.currentState.length = length;
          $scope.ready = true;
          $scope.loading = false;
          $scope.searching = false;
          $scope.$apply();
          $scope.search();
        })
        .catch(function (error) {
          $scope.setMessage('error', 'Internal server error: Failed to initialize Mopidy state');
          console.error('Failed to initialize Mopidy state:', error);
          $scope.ready = true;
          $scope.loading = false;
          $scope.searching = false;
          $scope.$apply();
        });

      /* Initialize available sources and filter away blacklisted ones */
      mopidy.library.browse({ "uri": null }).then(
        function (uri_results){
          const availableSources = uri_results.map(source => source.uri.split(":")[0]);
          const blacklistSet = new Set($scope.sources_blacklist);
          $scope.sources = availableSources.filter(src => !blacklistSet.has(src));
        }
      ).catch(function (error) {
        $scope.setMessage('error', 'Internal server error: Failed to browse Mopidy sources');
        console.error('Failed to browse Mopidy sources:', error);
      });

    });

    mopidy.on('event:playbackStateChanged', function (event) {
      $scope.currentState.paused = (event.new_state === 'paused');
      $scope.$apply();
    });

    mopidy.on('event:trackPlaybackStarted', function (event) {
      $scope.currentState.track = event.tl_track.track;
      $scope.$apply();
    });

    mopidy.on('event:tracklistChanged', function () {
      mopidy.tracklist.getLength().then(function (length) {
        $scope.currentState.length = length;
        $scope.$apply();
      }).catch(function (error) {
        $scope.setMessage('error', 'Internal server error: Failed to update tracklist length');
        console.error('Failed to update tracklist length:', error);
      });
    });

    $scope.printDuration = function (track) {
      if (!track.length)
        return '';

      var _sum = parseInt(track.length / 1000);
      var _min = parseInt(_sum / 60);
      var _sec = _sum % 60;

      return '(' + _min + ':' + (_sec < 10 ? '0' + _sec : _sec) + ')';
    };

    $scope.search = function () {
      if ($scope.autosubmitTime > 0) {
        cancelCountdown();
      }
      $scope.message = [];
      $scope.tracks = [];
      $scope.tracksToLookup = [];
      $scope.searchingSources = [];

      if (!$scope.searchField) {
        $scope.browse();
      } else {
        $scope.loadQueuedUris().then($scope.searchSourcesInParallel);
      }
    };

    //Autosubmit with countdown
    $scope.$watch('searchField', function(newVal, oldVal) {
      if ($scope.autosubmitTime > 0) {     
        if (newVal !== oldVal) {
          cancelCountdown(); // Reset previous timeouts
          countdownTime = $scope.autosubmitTime;
          startCountdown();
        }
      }
    });

    $scope.browse = function () {
        mopidy.library.browse({
          'uri': 'local:directory'  //TODO: depend on available sources
        }).then($scope.handleBrowseResult);
        return;
    }

    $scope.handleBrowseResult = function (res) {
      $scope.loading = false;
      $scope.searching = false;
      $scope.tracks = [];
      $scope.tracksToLookup = [];

      for (var i = 0; i < res.length; i++) {
        if (res[i].type == 'directory' && res[i].uri == 'local:directory?type=track') {
          mopidy.library.browse({
            'uri': res[i].uri
          }).then($scope.handleBrowseResult);
        } else if (res[i].type == 'track') {
          $scope.tracksToLookup.push(res[i].uri);
        }
      }

      if ($scope.tracksToLookup) {
        $scope.lookupOnePageOfTracks();
      }
    }

    $scope.lookupOnePageOfTracks = function () {
      mopidy.library.lookup({ 'uris': $scope.tracksToLookup.splice(0, $scope.maxTracksToLookup) }).then(function (tracklistResult) {
        var tracks = Object.values(tracklistResult).reduce(function (allTracks, singleTrackResult) {
          return allTracks.concat(singleTrackResult || []);
        }, []);
        $scope.addTrackResults(tracks);
      }).catch(function (error) {
        $scope.setMessage('error', 'Internal server error: Failed to lookup tracks');
        console.error('Failed to lookup tracks:', error);
      });
    };

    $scope.searchSourcesInParallel = function () {
      $scope.searchingSources = angular.copy($scope.sources);
      $scope.searching = true;

      const promises = $scope.sources.map(function (src) {
        return $scope.searchSources([src]).catch(function (error) {
          console.error('Search failed for', src, error);
        });
      });

      Promise.all(promises).finally(function () {
        $scope.searching = false;
        $scope.$apply();
      });
    };

    $scope.loadQueuedUris = function () {
      return mopidy.tracklist.getTlTracks().then(function (entries) {
        $scope.queuedTrackUris = new Set(entries.map(function (entry) {
          return entry.track && entry.track.uri;
        }).filter(function (uri) {
          return uri;
        }));
      }).catch(function (error) {
        console.error('Failed to load queued track URIs', error);
        $scope.queuedTrackUris = new Set();
      });
    };

    $scope.searchSources = function ($sourceList) {
      if($sourceList.length > 0) {
        return mopidy.library.search({
          'query': {
            'any': [$scope.searchField]
          },
          'uris': $sourceList.map(source => source + ':')
        }).then($scope.handleSearchResult);
      }
      return Promise.resolve();
    };

    $scope.handleSearchResult = function (res) {
      var _index = 0;
      var _found = true;
      const index = $scope.searchingSources.indexOf(getSource(res));
      if (index !== -1) {
        $scope.searchingSources.splice(index, 1);
      }
      for (var i = 0; i < res.length; i++) {
        if (res[i].tracks) {
          _index += $scope.addTrackResults(res[i].tracks);
        }
        if (_index >= $scope.maxTracksToLookup) {
          break;
        }
      }
      if ($scope.searchingSources.length < 1) {
        $scope.searching = false;
      }
      $scope.$apply();
    };

    $scope.addTrackResults = function (tracks) {
      let uris = [];
      const queuedUris = $scope.queuedTrackUris || new Set();
      tracks.forEach(function(track) {
        if ($scope.maxSongLengthMS <= 0 || track.length <= $scope.maxSongLengthMS) {
          if (queuedUris.has(track.uri)) {
            track.disabled = true;
          }
          $scope.tracks.push(track);
          uris.push(track.uri);
        }
      });
      $scope.$apply();
      return uris.length; //Return the number of tracks added to the list
    };

    $scope.addTrack = function (track, event) {
      track.disabled = true;

      $http.post('/party/add', track.uri).then(
        function success(response) {
          $scope.setMessage('success', 'Queued: ' + track.name, event);
        },
        function error(response) {
          if (response.status === 409) {
            $scope.setMessage('error', '' + response.data, event);
          } else {
            $scope.setMessage('error', 'Code ' + response.status + ' - ' + response.data, event);
          }
        }
      );
    };

    $scope.nextTrack = function (event) {
      $http.get('/party/vote').then(
        function success(response) {
          $scope.setMessage('success', '' + response.data, event);
        },
        function error(response) {
          $scope.setMessage('error', '' + response.data, event);
        }
      );
    };

    $scope.getTrackSource = function (track) {
      var sourceAsText = 'unknown';
      if (track.uri) {
        sourceAsText = track.uri.split(':', '1')[0];
      }

      return sourceAsText;
    };

    $scope.getFontAwesomeIcon = function (source) {
      var sources_with_fa_icon = ['bandcamp', 'mixcloud', 'pandora', 'soundcloud', 'spotify', 'youtube', 'tidal'];
      var css_class = 'fa fa-music';

      if (source == 'local') {
        css_class = 'fa fa-folder';
      } else if (sources_with_fa_icon.includes(source)) {
        css_class = 'fa-brands fa-' + source;
      }

      return css_class;
    };

    $scope.togglePause = function () {
      var _fn = $scope.currentState.paused ? mopidy.playback.resume : mopidy.playback.pause;
      _fn().catch(function (error) {
        $scope.setMessage('error', 'Failed to toggle playback');
        console.error('Failed to toggle playback:', error);
      });
    };

    //CONTROL PANEL STYLE START
    function adjustBodyPadding() {
      var controlPanel = document.getElementById('controlpanel');
      if (controlPanel) {
        document.body.style.paddingTop = controlPanel.offsetHeight + 'px';
      }
    }
    $timeout(adjustBodyPadding);
    angular.element($window).on('resize', adjustBodyPadding);
    $scope.$on('$destroy', function () {
      angular.element($window).off('resize', adjustBodyPadding);
    });
    //CONSTROL PANEL STYLE END

    //MESSAGE STYLE START
    $scope.setMessage = function(type, text, event) {
      $scope.message = [type, text];
      $scope.messageFadingOut = false;

      if (event && event.clientX !== undefined && event.clientY !== undefined) {
        var maxLeft = Math.max(10, $window.innerWidth - 260);
        var maxTop = Math.max(10, $window.innerHeight - 120);
        $scope.messagePosition = {
          top: Math.min(event.clientY, maxTop) + 'px',
          left: Math.min(event.clientX, maxLeft) + 'px'
        };
      } else {
        $scope.messagePosition = { top: '30px', left: '5px' };
      }

      if (type === 'error') {
        console.error('Error:', text);
      }

      if (messageTimer) {
        $timeout.cancel(messageTimer);
      }

      messageTimer = $timeout(function() {
        $scope.messageFadingOut = true;

        $timeout(function() {
          $scope.message = [];
          $scope.messageFadingOut = false;
          messageTimer = null;
        }, 500); // match fade-out time in CSS
      }, 5000);
    };

    $scope.closeMessage = function () {
      if (messageTimer) {
        $timeout.cancel(messageTimer);
        messageTimer = null;
      }
      $scope.message = [];
      $scope.messageFadingOut = false;
    };
    //MESSAGE STYLE END

    //SEARCH COUNTDOWN START
    function startCountdown() {
      $scope.submitSymbol = countdownTime.toString();
      countdownInterval = $timeout(function tick() {
        countdownTime--;
        if (countdownTime > 0) {
          $scope.submitSymbol = countdownTime.toString();
          countdownInterval = $timeout(tick, 1000);
        } else {
          $scope.search();
          $scope.submitSymbol = '↵';
        }
      }, 1000);
    }

    function cancelCountdown() {
      $timeout.cancel(countdownInterval);
      countdownTime = $scope.autosubmitTime;
      $scope.submitSymbol = '↵';
    }
    //SEARCH COUNTDOWN END

  });

function findFirstUri (obj) {
  if (typeof obj !== 'object' || obj === null) return null;

  if ('uri' in obj && typeof obj.uri === 'string') {
    return obj.uri;
  }

  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const found = findFirstUri(obj[key]);
      if (found) return found;
    }
  }

  return null;
}

function getSource (result) {
  var uri = findFirstUri(result);
  if (uri) {
    return uri.split(':', '1')[0];
  }
  return ""
}
