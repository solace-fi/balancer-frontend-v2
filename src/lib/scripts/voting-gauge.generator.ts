import { Network } from '@balancer-labs/sdk';
import { getAddress } from '@ethersproject/address';
import fs from 'fs';
import fetch from 'isomorphic-fetch';
import path from 'path';

import { TOKEN_LIST_MAP } from '@/constants/tokenlists';
import { POOLS } from '@/constants/voting-gauge-pools';
import { VotingGauge } from '@/constants/voting-gauges';
import { getPlatformId } from '@/services/coingecko/coingecko.service';

import vebalGauge from '../../../public/data/vebal-gauge.json';
import config from '../config';
import { isSameAddress } from '../utils';

function getBalancerAssetsURI(tokenAdress: string): string {
  return `https://raw.githubusercontent.com/balancer-labs/assets/master/assets/${tokenAdress.toLowerCase()}.png`;
}

function getBalancerAssetsMultichainURI(tokenAdress: string): string {
  return `https://raw.githubusercontent.com/balancer-labs/assets/refactor-for-multichain/assets/${tokenAdress.toLowerCase()}.png`;
}

async function getAssetURIFromTokenlists(
  tokenAddress: string,
  network: Network
): Promise<string> {
  const tokenListURIs = TOKEN_LIST_MAP[network.toString()];
  const allURIs = [
    ...Object.values(tokenListURIs.Balancer),
    ...tokenListURIs.External
  ].filter(uri => uri.includes('https'));

  const responses = await Promise.all(allURIs.map(uri => fetch(uri)));
  const tokenLists = await Promise.all(
    responses.map(response => response.json())
  );
  const allTokens = tokenLists.map(tokenList => tokenList.tokens).flat();

  const token = allTokens.find(token =>
    isSameAddress(token.address, tokenAddress)
  );
  return token?.logoURI ? token.logoURI : '';
}

async function getMainnetTokenAddresss(
  tokenAdress: string,
  network: Network
): Promise<string> {
  const coingeckoEndpoint = `https://api.coingecko.com/api/v3/coins/${getPlatformId(
    network.toString()
  )}/contract/${tokenAdress.toLowerCase()}`;

  const response = await fetch(coingeckoEndpoint);

  if (response.status === 200) {
    const data = await response.json();
    return getAddress(data.platforms.ethereum);
  } else {
    return '';
  }
}

function getTrustWalletAssetsURI(
  tokenAdress: string,
  network: Network
): string {
  const networksMap = {
    [Network.MAINNET]: 'ethereum',
    [Network.ARBITRUM]: 'arbitrum',
    [Network.POLYGON]: 'polygon',
    [Network.KOVAN]: 'kovan'
  };

  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${networksMap[network]}/assets/${tokenAdress}/logo.png`;
}

async function getTokenLogoURI(
  tokenAdress: string,
  network: Network
): Promise<string> {
  let logoUri = '';
  let response;

  if (network === Network.MAINNET) {
    logoUri = getBalancerAssetsURI(tokenAdress);
    response = await fetch(logoUri);
    if (response.status === 200) return logoUri;
  } else {
    logoUri = getBalancerAssetsMultichainURI(tokenAdress);
    response = await fetch(logoUri);
    if (response.status === 200) return logoUri;
  }

  logoUri = getTrustWalletAssetsURI(tokenAdress, network);
  response = await fetch(logoUri);
  if (response.status === 200) return logoUri;

  logoUri = await getAssetURIFromTokenlists(tokenAdress, network);
  if (logoUri) response = await fetch(logoUri);
  if (logoUri && response.status === 200) return logoUri;

  if (network === Network.ARBITRUM || network === Network.POLYGON) {
    const mainnetAddress = await getMainnetTokenAddresss(tokenAdress, network);
    logoUri = getTrustWalletAssetsURI(mainnetAddress, Network.MAINNET);
    response = await fetch(logoUri);
    if (logoUri && response.status === 200) return logoUri;
  }

  return '';
}

async function getPoolInfo(
  poolId: string,
  network: Network,
  retries = 5
): Promise<VotingGauge['pool']> {
  const subgraphEndpoint = config[network].subgraph;
  const query = `
    {
      pool(
        id: "${poolId}"
      ) {
        id
        address
        poolType
        symbol
        tokens {
          address
          weight
          symbol
        }
      }
    }
  `;

  try {
    const response = await fetch(subgraphEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const { data } = await response.json();
    const { id, address, poolType, symbol, tokens } = data.pool;

    const tokensList = tokens
      .filter(token => token.address != address)
      .map(token => {
        return {
          address: getAddress(token.address),
          weight: token.weight || 'null',
          symbol: token.symbol
        };
      });

    return {
      id,
      address: getAddress(address),
      poolType,
      symbol,
      tokens: tokensList
    };
  } catch {
    console.error('Pool not found:', poolId, 'chainId:', network);

    return retries > 0
      ? getPoolInfo(poolId, network, retries - 1)
      : ({} as VotingGauge['pool']);
  }
}

async function getLiquidityGaugeAddress(
  poolId: string,
  network: Network,
  retries = 5
): Promise<string> {
  const subgraphEndpoint = config[network].subgraphs.gauge;
  const query = `
    {
      liquidityGauges(
        where: {
          poolId: "${poolId}"
        }
      ) {
        id
      }
    }
  `;

  try {
    const response = await fetch(subgraphEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const { data } = await response.json();

    const liquidityGaugeAddress = getAddress(data.liquidityGauges[0].id);

    return liquidityGaugeAddress;
  } catch {
    console.error(
      'LiquidityGauge not found for poolId:',
      poolId,
      'chainId:',
      network
    );

    return retries > 0
      ? getLiquidityGaugeAddress(poolId, network, retries - 1)
      : '';
  }
}

async function getStreamerAddress(
  poolId: string,
  network: Network,
  retries = 5
): Promise<string> {
  const subgraphEndpoint = config[network].subgraphs.gauge;

  const query = `
    {
      liquidityGauges(
        where: {
          poolId: "${poolId}"
        }
      ) {
        streamer
      }
    }
  `;

  try {
    const response = await fetch(subgraphEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const { data } = await response.json();

    return data.liquidityGauges[0].streamer;
  } catch {
    console.error(
      'Streamer not found for poolId:',
      poolId,
      'chainId:',
      network,
      'retries:',
      retries
    );

    return retries > 0 ? getStreamerAddress(poolId, network, retries - 1) : '';
  }
}

async function getRootGaugeAddress(
  streamer: string,
  network: Network,
  retries = 5
): Promise<string> {
  const subgraphEndpoint = config[Network.MAINNET].subgraphs.gauge;

  const query = `
    {
      rootGauges(
        where: {
          recipient: "${streamer}"
          chain: ${config[network].shortName}
        }
      ) {
        id
      }
    }
  `;

  try {
    const response = await fetch(subgraphEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const { data } = await response.json();

    const rootGaugeAddress = getAddress(data.rootGauges[0].id);

    return rootGaugeAddress;
  } catch {
    console.error(
      'RootGauge not found for Streamer:',
      streamer,
      'chainId:',
      network
    );

    return retries > 0
      ? getRootGaugeAddress(streamer, network, retries - 1)
      : '';
  }
}

async function getGaugeAddress(
  poolId: string,
  network: Network
): Promise<string> {
  if ([Network.MAINNET, Network.KOVAN].includes(network)) {
    const gauge = await getLiquidityGaugeAddress(poolId, network);
    return gauge;
  } else {
    const streamer = await getStreamerAddress(poolId, network);
    const gauge = await getRootGaugeAddress(streamer, network);
    return gauge;
  }
}

(async () => {
  console.log('Generating voting-gauges.json...');

  let votingGauges = await Promise.all(
    POOLS.map(async ({ id, network }) => {
      // SOLACE_TODO: need voting gauges for all pools
      const address = await getGaugeAddress(id, network);
      const pool = await getPoolInfo(id, network);

      const tokenLogoURIs = {};
      for (let i = 0; i < pool.tokens.length; i++) {
        tokenLogoURIs[pool.tokens[i].address] = await getTokenLogoURI(
          pool.tokens[i].address,
          network
        );
      }

      return {
        address,
        network,
        pool,
        tokenLogoURIs
      };
    })
  );

  votingGauges = [vebalGauge as VotingGauge, ...votingGauges];

  const jsonFilePath = path.resolve(
    __dirname,
    '../../../public/data/voting-gauges.json'
  );

  fs.writeFile(jsonFilePath, JSON.stringify(votingGauges, null, 2), err => {
    if (err) {
      console.log(err);
    }
  });
})();
