const fs = require("fs");
const Account = require("./helpers/account.js");
const config = require("./config_reportserver.json");
const colors = {
	general: "\x1b[37m",
	login: "\x1b[36m",
	loggedIn: "\x1b[33m",
	connectedToGC: "\x1b[35m",
	success: "\x1b[32m",
	error: "\x1b[31m"
};

// Shittily parse command line arguments
if (process.argv[2]) {
	config.MatchID = process.argv[2];
}

if (process.argv[3]) {
	try {
		if (!isNaN(parseInt(process.argv[3]))) {
			config.ReportsToSend = parseInt(process.argv[3]);
		} else {
			throw new Error("Not a number");
		}
	} catch(e) {
		console.log(colors.error + "Failed to parse ReportsToSend via command line argument");
	};
}

// Add all accounts to the config
config.accounts = require("./accounts.json");

var curProxy = -1;
var proxyChunk = 0;
var reportsSent = 0;
var reportsFailed = 0;

console.log(colors.general + "Getting " + config.ReportsToSend + " account" + (config.ReportsToSend === 1 ? "" : "s"));

// First we get all available accounts (You can report once every 24 hours)
var available = config.accounts.filter(a => a.operational === true && a.requiresSteamGuard === false && (new Date().getTime() - (a.lastServerReport ? a.lastServerReport : -1)) >= config.AccountCooldown);

// Check if we have enough available accounts
if (available.length < config.ReportsToSend) {
	console.log(colors.general + available.length + "/" + config.accounts.length + " account" + (config.accounts.length === 1 ? "" : "s") + " available but we need " + config.ReportsToSend + " account" + (config.ReportsToSend === 1 ? "" : "s"));
	return;
}

// Get needed accounts
var accountsToUse = available.slice(0, config.ReportsToSend);

// Split accounts into chunks, do "ReportsPerChunk" at a time
var chunks = chunkArray(accountsToUse, config.Chunks.ReportsPerChunk);
var chunkComplete = 0;
var chunkCompleteLimit = -1;
var hitRatelimit = false;

(async () => {
	// Wait 5 seconds before starting the actual process
	await new Promise(r => setTimeout(r, (5 * 1000)));

	// Go through all chunks, use await to slow it down
	for (let chunk of chunks) {
		// If we previously hit the ratelimit then wait "RateLimitedCooldown" ms
		if (hitRatelimit === true) {
			console.log(colors.general + "We have hit the ratelimit, waiting " + config.RateLimitedCooldown + "ms");
			await new Promise(r => setTimeout(r, config.RateLimitedCooldown));
		}

		chunkCompleteLimit = chunk.length;

		// Do 100 at once and await until they are done
		var result = await new Promise((resolve, reject) => {
			// We are doing a new chunk, set the "hitRatelimit" to false
			hitRatelimit = false;

			for (let account of chunk) {
				accountHandler(account, resolve);
			}
		});

		// Increase our proxyChunk count
		proxyChunk++;

		// If the result is "true" that means we have another one to do, if its false it means we are at the end and dont need to wait more
		if (result === true) {
			// Wait "BeautifyDelay" ms so the message actually appears at the bottom and not somewhere in the middle
			await new Promise(r => setTimeout(r, config.Chunks.BeautifyDelay));

			console.log(colors.general + "Waiting " + parseInt(config.Chunks.TimeBetweenChunks / 1000) + " second" + (parseInt(config.Chunks.TimeBetweenChunks / 60) === 1 ? "" : "s"));

			// Wait 60 seconds and then repeat the loop
			await new Promise(r => setTimeout(r, config.Chunks.TimeBetweenChunks));
		}
	}
})();

function accountHandler(account, resolve) {
	try {
		console.log(colors.login + "[" + account.username + "] Logging into account");

		const acc = new Account(account.username, account.password, account.sharedSecret, getProxy());

		acc.on("loggedOn", () => {
			console.log(colors.loggedIn + "[" + account.username + "] Successfully logged into account");
		});

		acc.on("ready", async (hello) => {
			console.log(colors.connectedToGC + "[" + account.username + "] Connected to CSGO GameCoordinator");

			// Wait "TimeBetweenConnectionAndSending" ms before sending the report
			await new Promise(r => setTimeout(r, config.Chunks.TimeBetweenConnectionAndSending));

			acc.reportServer(config.MatchID, (30 * 1000), config.Report.PoorPerformance, config.Report.AbusiveModels, config.Report.BadMOTD, config.Report.ListingAbuse, config.Report.InventoryAbuse).then((response) => {
				reportsSent += 1;

				console.log(colors.success + "[" + account.username + "] Successfully sent a report " + reportsSent + "/" + config.ReportsToSend + " - " + response.confirmation_id);

				acc.logout();

				var index = config.accounts.map(a => a.username).indexOf(account.username);
				if (index >= 0) {
					config.accounts[index].lastReport = new Date().getTime();
				}

				delete acc;
				checkComplete(resolve);
			}).catch((err) => {
				// Reporting while not even being connected to the GC... Makes sense
				if (typeof err === "string" && err === "previously_timed_out") {
					return;
				}

				reportsFailed += 1;

				console.log(colors.error + "[" + account.username + "] Has encountered an error");
				console.error(err);

				acc.logout();

				var index = config.accounts.map(a => a.username).indexOf(account.username);
				if (index >= 0) {
					config.accounts[index].lastReport = new Date().getTime();
				}

				delete acc;
				checkComplete(resolve);
			});
		});

		acc.on("steamGuard", () => {
			reportsFailed += 1;

			console.log(colors.error + "[" + account.username + "] Requires a SteamGuard code");

			var index = config.accounts.map(a => a.username).indexOf(account.username);
			if (index >= 0) {
				config.accounts[index].requiresSteamGuard = true;
			}

			acc.logout();

			delete acc;
			checkComplete(resolve);
		});

		acc.on("error", (err) => {
			reportsFailed += 1;

			console.log(colors.error + "[" + account.username + "] Has encountered an error");
			console.error(err);

			if (err.eresult === 84) {
				// we have hit the ratelimit set "hitRatelimit" to true
				hitRatelimit = true;
			}

			var index = config.accounts.map(a => a.username).indexOf(account.username);
			if (index >= 0) {
				// If the error is "RateLimitExceeded" just ignore it, we can still use the account just fine after the ratelimit is over
				config.accounts[index].operational = isNaN(err.eresult) ? false : (err.eresult === 84 ? true : err.eresult);
			}

			acc.logout();

			delete acc;
			checkComplete(resolve);
		});
	} catch(err) {
		reportsFailed += 1;

		if (account) {
			console.log(colors.error +"[" + account.username + "] Has encountered an error");

			var index = config.accounts.map(a => a.username).indexOf(account.username);
			if (index >= 0) {
				config.accounts[index].operational = isNaN(err.eresult) ? false : err.eresult;
			}
		}

		console.error(err);

		if (typeof acc !== "undefined") {
			acc.logout();
		}

		delete acc;
		checkComplete(resolve);
	}
}

function checkComplete(resolve) {
	// Always increment this, as everytime we check one has finished (successfully or not doesnt matter in this case)
	chunkComplete++;

	// Global complete
	if ((reportsSent + reportsFailed) >= config.ReportsToSend) {
		resolve(false);

		// Update our accounts.json
		fs.writeFileSync("./accounts.json", JSON.stringify(config.accounts, null, 4));

		// We have successfully sent all reports and are now done here
		console.log(colors.general + "Successfully sent " + reportsSent + "/" + config.ReportsToSend + " report" + (config.ReportsToSend === 1 ? "" : "s") + ", " + reportsFailed + " report" + (reportsFailed === 1 ? "" : "s") + " failed");
		return;
	}

	// Chunk complete
	if (chunkComplete >= chunkCompleteLimit) {
		// Write on every completed chunk
		fs.writeFileSync("./accounts.json", JSON.stringify(config.accounts, null, 4));

		resolve(true);
	}
}

function getProxy() {
	// If "config.Chunks.SwitchProxyEvery" many chunks have passed we switch to the next one
	if (proxyChunk >= config.Chunks.SwitchProxyEvery) {
		proxyChunk = 0;
		curProxy += 1;
	}

	// If we are outside the array bounds go back to 0
	if (!config.Proxies[curProxy]) {
		curProxy = 0;
	}

	// If we are still outside the array bounds despite being at 0 then no list is defined
	if (!config.Proxies[curProxy]) {
		return undefined;
	}

	return config.Proxies[curProxy];
}

// Copied from: https://ourcodeworld.com/articles/read/278/how-to-split-an-array-into-chunks-of-the-same-size-easily-in-javascript
function chunkArray(myArray, chunk_size) {
	var tempArray = [];

	for (let index = 0; index < myArray.length; index += chunk_size) {
		myChunk = myArray.slice(index, index + chunk_size);
		tempArray.push(myChunk);
	}

	return tempArray;
}
