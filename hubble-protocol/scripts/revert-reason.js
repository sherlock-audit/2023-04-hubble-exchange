const ethers = require('ethers')

const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL)

function hex_to_ascii(str1) {
	var hex  = str1.toString();
	var str = '';
	for (var n = 0; n < hex.length; n += 2) {
		str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
	}
	return str;
 }

async function debug() {
    const txHash = '0x7632ce76d9ea616e38f6d430ee9b9ba6514c868f8c26ca8c95f572549e752566'
    const tx = await provider.getTransaction(txHash)
    const code = await provider.call(tx, tx.blockNumber)
    console.log(code)
    let reason = hex_to_ascii(code.slice(138))
    console.log('revert reason:', reason)
}

debug()
