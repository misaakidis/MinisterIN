/*jshint esnext: true */

// Include needed node.js modules
var http = require('http');
var Twitter = require('twitter');
var irc = require('irc');
var bot = require('./ircbot.js');
var gh_webhook = require('github-webhook-handler');
var program = require('commander');
var mqtt = require ('mqtt');
var fs = require('fs');

var numOfHackers = -1;
var spaceOpen = false;

program
.version('1.2.1')
.usage('space=[open/closed]')
.option('-s, --space <state>', 'Whether the space is open or closed (default = closed)', /^(closed|open)$/i, 'closed')
.parse(process.argv);

// Check if "space=open" was given as argument
spaceOpen = program.space.toLowerCase() === 'open';

// Read MQTT configuration file
var mqttConfig;
try {
  mqttConfig = require('./mqtt_config.json');
} catch (e) {
  console.log('Could not parse MQTT configuration file: ' + e.message);
  mqttConfig = {
    caFile : "MQTT-CA-TM.crt",
    port : "1883",
    host : "www.techministry.gr"
  };
}

// Create an object with the API keys and access tokens
var APIKeys = require('./apikeys.json');
// If the keys file cannot be parsed, MinisterIN terminates abnormally

// Read tweet messages from the tweets.json file
var tweetMsgs;
var helloMsgs;
try {
  tweetMsgs = require('./tweets.json');
} catch (e) {
  console.log('Could not parse tweets file: ' + e.message);
  tweetMsgs = {
    'statusOpen': [
      "Minister is in"
    ],
    'statusClosed': [
      "Minister is out"
    ]
  };
}
try {
  helloMsgs = require('./hello.json');
} catch (e) {
  console.log('Could not parse hello file: ' + e.message);
  helloMsgs = {
    'hello': [
      "hello!"
    ]
  };
}

// Create a twitter client
var twitterClient = new Twitter({
  consumer_key: APIKeys.twitter.consumer_key,
  consumer_secret: APIKeys.twitter.consumer_secret,
  access_token_key: APIKeys.twitter.access_token_key,
  access_token_secret: APIKeys.twitter.access_token_secret
});

// Read IRC configuration file
var ircConfig;
try {
  ircConfig = require('./irc_config.json');
} catch (e) {
  console.log('Could not parse IRC configuration file: ' + e.message);
  ircConfig = {
    server: "irc.freenode.net",
    nick: "ConsuelaTM",
    channels: ["#TechMinistry"]
  };
}

var CA = fs.readFileSync(__dirname + "/" + mqttConfig.caFile);

var mqttOptions = {
  port: mqttConfig.port,
  host: mqttConfig.host,
  protocol: 'mqtts',
  rejectUnauthorized : true,
  //The CA list will be used to determine if server is authorized
  ca: CA
};

var client = mqtt.connect(mqttOptions);
client.on('connect', function(){
  console.log('Connected to MQTT broker ' + mqttConfig.host);
});


// Create an IRC client
var ircClient = new irc.Client(ircConfig.server, ircConfig.nick, ircConfig);
ircClient.sayAllChannels = function(message) {
  ircConfig.channels.forEach(function(channel) {
    ircClient.say(channel, message);
  });
};

/**
* Tweet the status of the space
*
* @param newStatus true if the space is open,
* false if the space is closed.
*/
var tweetSpaceOpened = function(newStatus) {
  var tweetMsg;
  var rand;
  if (newStatus) {
    rand = Math.floor(Math.random() * tweetMsgs.statusOpen.length);
    tweetMsg = tweetMsgs.statusOpen[rand] + ' - Space: OPEN';
  } else {
    rand = Math.floor(Math.random() * tweetMsgs.statusClosed.length);
    tweetMsg = tweetMsgs.statusClosed[rand] + ' - Space: CLOSED';
  }

  twitterClient.post('statuses/update', {status: tweetMsg},  function(error, tweet, response){
    if (error) {
      console.log('Could not tweet: ' + tweet);  // Tweet body.
      console.log(response);  // Raw response object.
    } else {
      // IRC bot says the random message in the channel
      ircClient.sayAllChannels(tweetMsg);
      console.log('Successfully tweeted: ' + tweet);

      // Update the status of the spaceOpen variable only after the status
      // got successfully tweeted
      spaceOpen = newStatus;
    }
  });
};


/**
* Updates the status of the space, given the number
* of the hackers there.
*
* @param numOfHackers the number of hackers in space. or NaN
* in case there was an error while parsing the hackers.txt file.
*/
var updateStatus = function(numOfHackers) {
  if (spaceOpen) {
    if (numOfHackers === 0) {
      // If space status was open and there are no hackers anymore
      console.log('Space is empty.');
      tweetSpaceOpened(false);
    }
  } else {
    if (numOfHackers > 0) {
      // If space was closed and there are hackers now
      console.log('Space is open!');
      tweetSpaceOpened(true);
    }
  }
};

// Reply to questions directed to Consuela
ircClient.addListener('message#TechMinistry', function(from, message) {
  var reply = bot(message, numOfHackers, helloMsgs);
  if (reply !== undefined) {
    ircClient.say(ircConfig.channels[0], from + reply);
  }
});

// Welcome new people joining the Techministry channel
ircClient.addListener('join#TechMinistry', function(nick, message) {
    ircClient.say(ircConfig.channels[0], nick + ", " +
      helloMsgs.hello[Math.floor(Math.random() * helloMsgs.hello.length)]);
});

// Github organization Webhooks
var gh_webhook_handler = gh_webhook({'path': '/techministry', 'secret': APIKeys.github.webhook});
http.createServer(function (req, res) {
  gh_webhook_handler(req, res, function (err) {
    res.statusCode = 404;
    res.end('No such location');
  });
}).listen(7777);

gh_webhook_handler.on('push', function (event) {
  ircClient.sayAllChannels(event.payload.pusher.name + ' pushed to repository ' + event.payload.repository.name + ':');
  event.payload.commits.forEach(function(commit) {
    ircClient.sayAllChannels('* ' + commit.author.name + ' - ' + commit.message);
  });
});

gh_webhook_handler.on('error', function (err) {
  console.error('Github Webhook error:', err.message);
});

// Add MQTT listener callback
client.on('message', function(topic, message) {
  numOfHackers = parseInt(message.toString());
  // If message could not be parsed to number
  if (isNaN(numOfHackers)) {
    console.log('Could not parse number of hackers: ' + message.toString());
    return;
  }

  updateStatus(numOfHackers);
  // Uncomment to debug number of hackers
  //console.log('Number of Hackers: ' + numOfHackers);
});

client.subscribe('techministry/spacestatus/hackers');
