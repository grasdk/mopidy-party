'use strict';

// TODO : add a mopidy service designed for angular, to avoid ugly $scope.$apply()...
angular.module('partyApp', [])
  .controller('MainController', function($scope) {

  // Scope variables

  $scope.message = [];
  $scope.tracks  = [];
  $scope.tracksToLookup = [];
  $scope.maxTracksToLookupAtOnce = 50;
  $scope.loading = true;
  $scope.ready   = false;
  $scope.currentState = {
    paused : false,
    length : 0,
    track  : {
      length : 0,
      name   : 'Nothing playing, add some songs to get the party going!'
    }
  };
  $scope.sources = [];
  $scope.sources_blacklist = ['cd', 'file'];
  $scope.sources_primary = ['local', 'tidal']; //todo: make into a config value
  $scope.sources_secondary = [];

  // Initialize

  var mopidy = new Mopidy({
    'callingConvention' : 'by-position-or-by-name'
  });

  // Adding listenners
  mopidy.on('state:online', function () {
    mopidy.playback
    .getCurrentTrack()
    .then(function(track){
      if(track)
        $scope.currentState.track = track;
      return mopidy.playback.getState();
    })
    .then(function(state){
      $scope.currentState.paused = (state === 'paused');
      return mopidy.tracklist.getLength();
    })
    .then(function(length){
      $scope.currentState.length = length;
    })
    .done(function(){
      $scope.ready   = true;
      $scope.loading = false;
      $scope.$apply();
      $scope.search();
    });
	
	/* Initialize available sources */
	mopidy.library.browse({"uri": null}).done(
		function(uri_results) {
			//var filtered_sources = uri_results.filter(uri_result => !(uri_result.uri.includes("youtube")));
			$scope.sources = uri_results.map(source => source.uri.split(":")[0]);
			//primary sources among available sources
			$scope.sources_primary = $scope.sources_primary.filter(source => $scope.sources.includes(source));
			//secondary sources are the available sources, not counting the blacklist
			$scope.sources_secondary = $scope.sources.filter(source => !$scope.sources_blacklist.includes(source));
			//secondary sources also need to be disjoint from the primary sources
			$scope.sources_secondary = $scope.sources_secondary.filter(source => !$scope.sources_primary.includes(source));
		}
	);

  });
  mopidy.on('event:playbackStateChanged', function(event){
    $scope.currentState.paused = (event.new_state === 'paused');
    $scope.$apply();
  });
  mopidy.on('event:trackPlaybackStarted', function(event){
    $scope.currentState.track = event.tl_track.track;
    $scope.$apply();
  });
  mopidy.on('event:tracklistChanged', function(){
    mopidy.tracklist.getLength().done(function(length){
      $scope.currentState.length = length;
      $scope.$apply();
    });
  });

  $scope.printDuration = function(track){

    if(!track.length)
      return '';

    var _sum = parseInt(track.length / 1000);
    var _min = parseInt(_sum / 60);
    var _sec = _sum % 60;

    return '(' + _min + ':' + (_sec < 10 ? '0' + _sec : _sec) + ')' ;
  };
  
  $scope.search = function(){

    $scope.message = [];
    $scope.loading = true;
    if(!$scope.searchField) {
	  //browse local library when search field is blank
      mopidy.library.browse({
        'uri' : 'local:directory'
      }).done($scope.handleBrowseResult);
      return;
    }

    mopidy.library.search({
      'query': {
        'any' : [$scope.searchField]
      },
	  'uris' : $scope.sources_primary.map(source => source+':')
    }).done($scope.handleSearchResult);
	
	mopidy.library.search({
      'query': {
        'any' : [$scope.searchField]
      },
	  'uris' : $scope.sources_secondary.map(source => source+':')
    }).done($scope.handleSecondarySearchResult);
  };


  $scope.handleBrowseResult = function(res){
    $scope.loading = false;
    $scope.tracks  = [];
    $scope.tracksToLookup = [];

    for(var i = 0; i < res.length; i++){
      if(res[i].type == 'directory' && res[i].uri == 'local:directory?type=track'){
        mopidy.library.browse({
          'uri' : res[i].uri
        }).done($scope.handleBrowseResult);
      } else if(res[i].type == 'track'){
        $scope.tracksToLookup.push(res[i].uri);
      }
    }
    if($scope.tracksToLookup) {
      $scope.lookupOnePageOfTracks();
    }
  }

  $scope.lookupOnePageOfTracks = function(){
	mopidy.library.lookup({'uris' : $scope.tracksToLookup.slice(0, $scope.maxTracksToLookupAtOnce)}).done(function(tracklist){
        for(var j = 0; j < tracklist.length; j++){
          $scope.addTrackResult(tracklist[j]);
        }
        $scope.$apply();
    });
  };

  $scope.handleSearchResult = function(res){
    $scope.tracks  = [];

    var _index = 0;
    var _found = true;
    while(_found){
      _found = false;
      for(var i = 0; i < res.length; i++){
		console.log(res[i]);
        if(res[i].tracks && res[i].tracks[_index]){
          $scope.addTrackResult(res[i].tracks[_index]);
          _found = true;
        }
      }
      _index++;
    }

    $scope.$apply();
  };
  
  $scope.handleSecondarySearchResult = function(res){
    var _index = 0;
    var _found = true;
    while(_found){
      _found = false;
      for(var i = 0; i < res.length; i++){
		console.log(res[i]);
        if(res[i].tracks && res[i].tracks[_index]){
		  console.log("length is "+res[i].tracks[_index].length);
		  if(res[i].tracks[_index].length < 600000) { //TODO make into a config value
			$scope.addTrackResult(res[i].tracks[_index]);
		  }
          _found = true;
        }
      }
      _index++;
    }
    $scope.loading = false;
    $scope.$apply();
  };
  

  $scope.addTrackResult = function(track){

    $scope.tracks.push(track);
    mopidy.tracklist.filter({'uri': [track.uri]}).done(
      function(matches){
        if (matches.length) {
          for (var i = 0; i < $scope.tracks.length; i++)
          {
            if ($scope.tracks[i].uri == matches[0].track.uri)
              $scope.tracks[i].disabled = true;
          }
          $scope.$apply();
        }
      });
  };

  $scope.addTrack = function(track){

    track.disabled = true;

    var xmlHttp = new XMLHttpRequest();
    xmlHttp.open( "POST", "/party/add", false ); // false for synchronous request
    xmlHttp.send(track.uri);
    var msgtype = 'success'
    if (xmlHttp.status >= 400) {
      track.disabled = false;
      $scope.message = ['error', xmlHttp.responseText];
    } else {
      $scope.message = ['success', 'Queued: ' + track.name];
    }
    $scope.$apply();
  };

  $scope.nextTrack = function(){
    var xmlHttp = new XMLHttpRequest();
    xmlHttp.open( "GET", "/party/vote", false ); // false for synchronous request
    xmlHttp.send( null );
    $scope.message = ['success', xmlHttp.responseText];
    $scope.$apply();
  };
  
  $scope.getTrackSource = function(track){
	  var sourceAsText = "unknown";
	  if (track.uri) {
		  sourceAsText = track.uri.split(":", "1")[0];
	  }
	  return sourceAsText;
  };
  
    
  $scope.getFontAwesomeIcon = function(source){
      var sources_with_fa_icon = ["bandcamp", "mixcloud", "soundcloud", "spotify", "youtube"];
	  var css_class =  "fa fa-music";
	  if (source == "local") {
		  css_class = "fa fa-folder";
	  } else if (sources_with_fa_icon.includes(source)) {
		  css_class = "fa-brands fa-"+source;
	  }
	  return css_class;
  };


  $scope.togglePause = function(){
    var _fn = $scope.currentState.paused ? mopidy.playback.resume : mopidy.playback.pause;
    _fn().done();
  };


});
