# HKGPX
A HKGolden proxy server written in node.js

# Why a proxy?
- Avoiding HKGolden's rate limit for each IP
 - HKGolden has rate limit for each request IP
 - Some mobile carriers (SmarTone) does not have enough IPs for its users
 - Thus, some mobile carrier users may not be able to 上高登

# Why HKGPX instead of other proxies (HTTP/SOCKS/VPN...)?
- You can make your server a safe public server. Your friends/other forum members can use yours
- Authenicate each proxy user with their HKGolden account
- Minimum interval of requesting to HKGolden's server to avoid triggering it's rate limit
- Topic list caching
- Topic caching && topic long-term caching

# Why build a HKGPX server instead of using datHKG's public servers?
- We log your IP, cookies and any other request info for security purposes (in case of legal issues).
- The public servers will get slower if users amount increases.

# Quick start?
1. Install `git`, `node.js`, `npm` in your system.
2. `$ git clone https://github.com/Saren-Arterius/hkgpx.git`
3. `$ cd hkgpx`
4. `$ npm install`
5. `$ node server.js`

# Settings?
See `server.js`.
