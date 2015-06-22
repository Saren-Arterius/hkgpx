# HKGPX
A HKGolden proxy server written in node.js

# Why a proxy?
- Avoiding HKGolden's rate limit for each IP
 - HKGolden has rate limit for each request IP
 - Some mobile carriers (SmarTone) does not have enough IPs for its users
 - Thus, some mobile carrier users may not be able to 上高登

# Why HKGPX instead of other proxies (HTTP/SOCKS/VPN...)?
- Authenicate each proxy user with their HKGolden account
- Minimum interval of requesting to HKGolden's server to avoid triggering it's rate limit
- Does not require users to build their own proxy, they can use yours
- Topic list caching
- Topic caching && topic long-term caching

# Why build a HKGPX server instead of using datHKG's default options?
- We log your IP, cookies and any other request info for security purposes (in case of legal issues).

# Quick start?
1. Install `git`, `node.js`, `npm` in your system.
2. `$ git clone https://github.com/Saren-Arterius/hkgpx.git`
3. `$ cd hkgpx`
4. `$ npm install`
5. `$ node server.js`

# Settings?
See `server.js`.
