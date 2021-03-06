const ganache = require('ganache-cli');
const Web3 = require('web3');
const path = require('path');
const { exec } = require('child_process');

jest.mock('node-fetch');
const fetch = require('node-fetch');

const projectDir = new RegExp(process.cwd(), 'g');
const replacement = '$PROJECT_DIR';
const exclude = new Set(['web3', 'logger', 'bytecode', 'sourceCode']);

const hexR = /^0x[0-9a-fA-F]+$/;

const replaceCWD = val => {
  const replace = original => {
    if (typeof original === 'string') return original.replace(projectDir, replacement);

    if (Array.isArray(original)) {
      return original.map(replace);
    }

    if (typeof original === 'object' && original !== null) {
      return Object.keys(original).reduce((accum, k) => {
        if (exclude.has(k)) accum[k] = original[k];
        else accum[k] = replace(original[k]);

        return accum;
      }, {});
    }

    return original;
  };

  return replace(val);
};

const fs = require('fs-extra');

const { Response } = jest.requireActual('node-fetch');

let web3;
let server;
let cwd;
let artifacts;

const gatherDataFromArtifacts = require('../src/gather_data_from_artifacts');
const filterOutVerified = require('../src/filter_out_verified');
const flattenContracts = require('../src/flatten_contracts');
const outputFlattened = require('../src/output_flattened');
const getConstructorArguments = require('../src/get_constructor_arguments');
const postToVerify = require('../src/post_to_verify');
const { processConfig, processPluginConfig } = require('../src/process_config');

const NETWORK_ID = 4;
const NETWORK_NAME = 'rinkeby';
const SEED = 42;

const getInputFiles = async () => {
  const artifactFilenames = await fs.readdir('./build/contracts');

  return artifactFilenames.map(art => path.join('./build/contracts', art));
};

beforeAll(async done => {
  process.chdir('./truffle-test-example');
  cwd = process.cwd();

  server = ganache.server({ network_id: NETWORK_ID, seed: SEED });

  server.once('error', done);

  console.log('Starting GANACHE server');
  server.listen(8545, err => {
    if (err) return done(err);
    console.log('GANACHE server started');
    exec(
      // 'cd ./truffle-test-example && npx truffle compile && npx truffle migrate'
      // have to do reset,
      // otherwise truffle assumes fixed network_id, blockchain is the same
      // and tries to read Migrations
      'npx truffle compile && npx truffle migrate --reset',
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        server.removeListener('error', done);
        if (error) {
          console.log('stdout: ', stdout);
          console.log('stderr: ', stderr);
          return done(error);
        }
        console.log('Contracts are compiled and migrated');

        // supresses MaxListenersExceededWarning
        server.provider.setMaxListeners(20);
        web3 = new Web3(server.provider);

        done();
      }
    );
  });
}, 50000);

let config;
let apiUrl;
beforeAll(async () => {
  // console.log('SECOND beforeAll');
  artifacts = await getInputFiles();

  apiUrl = `https://api${NETWORK_NAME === 'mainnet' ? '' : `-${NETWORK_NAME}`}.etherscan.io/api`;

  config = {
    working_directory: cwd,
    network: NETWORK_NAME,
    _: [, ...artifacts],
    provider: server.provider,
    compilers: {
      solc: {
        version: '0.5.2',
        settings: {}
      }
    }
  };
});

afterAll(done => {
  console.log('Stopping GANACHE server');
  server.close(err => {
    if (err) done(err);
    console.log('GANACHE server stopped');
    done();
  });
});

describe('Process config', () => {
  test('plugin config', async () => {
    const options = await processPluginConfig(config);

    expect(replaceCWD(options)).toMatchSnapshot(
      {
        web3: expect.any(Web3)
      },
      'Plugin config'
    );
  });
  test('plugin config without network throws', async () => {
    await expect(processPluginConfig({ ...config, network: undefined })).rejects.toThrow(
      'No network provided. Run truffle run verify --help to see usage.'
    );
  });
  test('plugin config with invalid provider throws', async () => {
    await expect(
      processPluginConfig({
        ...config,
        get provider() {
          throw new Error();
        }
      })
    ).rejects.toThrow(`No valid provider for network ${config.network} in truffle.js`);
  });
  test('working config', async () => {
    const options = await processConfig({ artifacts, web3 });

    expect(options.apiUrl).toEqual(apiUrl);

    expect(replaceCWD(options)).toMatchSnapshot(
      {
        web3: expect.any(Web3),
        logger: expect.any(Object)
      },
      'Lib config'
    );
  });
  test('working config with web3 connected to an unsupported network throws', async () => {
    const unavailableId = 12345;
    const web3mock = {
      eth: {
        net: {
          getId: () => Promise.resolve(unavailableId)
        }
      }
    };
    await expect(processConfig({ artifacts, web3: web3mock })).rejects.toThrow(
      `Network with id ${unavailableId} isn't available on etherscan.io for verification`
    );
  });
});

let artifactsData;

test('Gathers data from Artifacts', async () => {
  artifactsData = await gatherDataFromArtifacts({
    artifacts,
    networkId: NETWORK_ID
  });

  const artifactKeys = Object.keys(artifactsData);

  expect(artifactKeys).toMatchSnapshot('Artifact paths');

  artifactKeys.forEach(key => {
    expect(replaceCWD(artifactsData[key])).toMatchSnapshot(
      {
        bytecode: expect.any(String),
        txhash: expect.stringMatching(hexR)
      },
      path.basename(key)
    );
  });
});

test('Filters out verified contracts', async () => {
  const logger = {
    log: jest.fn()
  };

  const verifiedResp = JSON.stringify({ status: '1' });
  const unverifiedResp = JSON.stringify({ status: '0' });
  fetch
    .mockReturnValueOnce(new Response(verifiedResp))
    .mockReturnValueOnce(new Response(verifiedResp))
    .mockImplementation(() => new Response(unverifiedResp));
  logger.log
    .mockReturnValueOnce(new Response(verifiedResp))
    .mockReturnValueOnce(new Response(verifiedResp))
    .mockImplementation(() => new Response(unverifiedResp));

  const { unverified: unverifiedContracts, alreadyVerified } = await filterOutVerified(
    artifactsData,
    { apiUrl, logger }
  );

  expect(fetch.mock.calls).toMatchSnapshot('Fetch calls');

  const fetchReturns = fetch.mock.results.map(({ value: response }) => JSON.parse(response.body));
  expect(fetchReturns).toMatchSnapshot('Fetch returns');

  expect(replaceCWD(alreadyVerified)).toMatchSnapshot('Already verified');

  const all = Object.keys(artifactsData).length;
  const unverifiedKeys = Object.keys(unverifiedContracts);
  const verified = all - unverifiedKeys.length;
  expect(verified).toEqual(2);
  expect(verified).toEqual(alreadyVerified.length);

  expect(unverifiedKeys).toMatchSnapshot('Unverified contracts');

  unverifiedKeys.forEach(key => {
    expect(replaceCWD(unverifiedContracts[key])).toMatchSnapshot(
      {
        bytecode: expect.any(String),
        txhash: expect.stringMatching(hexR)
      },
      path.basename(key)
    );
  });

  expect(logger.log.mock.calls).toMatchSnapshot('Log calls');
});

let flattenedContracts;
test('Flattens contracts linked from artifacts', async () => {
  flattenedContracts = await flattenContracts(artifactsData);

  expect(flattenedContracts).toMatchSnapshot('Flattened contracts');
});

describe('Outputs Flattened', () => {
  const output = './output/here';

  let spies;

  beforeAll(() => {
    spies = ['mkdirp', 'writeFile'].map(fname =>
      jest.spyOn(fs, fname).mockImplementation(() => {})
    );
  });
  afterAll(() => spies.forEach(spy => spy.mockRestore()));

  test('outputs flattened contracts to a folder', async () => {
    await outputFlattened(artifactsData, flattenedContracts, { output });

    expect(spies[0]).toHaveBeenCalledTimes(1);
    expect(spies[0]).toHaveBeenCalledWith(output);

    expect(replaceCWD(spies[1].mock.calls)).toMatchSnapshot('fs.writeFile calls');
  });
  test('does nothing when flattenContracts is empty', async () => {
    await outputFlattened(artifactsData, {}, { output });

    expect(spies[0]).toHaveBeenCalledTimes(0);
    expect(spies[1]).toHaveBeenCalledTimes(0);
  });
});

let constructorData;

test('Gathers constructor arguments for relevant contracts', async () => {
  constructorData = await getConstructorArguments(artifactsData, {
    web3
  });

  expect(constructorData).toMatchSnapshot('Constructor arguments');

  const filesWithConstructors = Object.keys(constructorData);

  const constructorArguments = await Promise.all(
    filesWithConstructors.map(async file => {
      const art = await fs.readJSON(file);
      const { inputs } = art.abi.find(({ type }) => type === 'constructor');

      const encodedArguments = `0x${constructorData[file]}`;

      return web3.eth.abi.decodeParameters(inputs, encodedArguments);
    })
  );

  const constructorDataDecoded = filesWithConstructors.reduce((accum, file, i) => {
    accum[file] = constructorArguments[i];
    return accum;
  }, {});

  expect(constructorDataDecoded).toMatchSnapshot('Decoded constructor arguments');
});

test('Posts to verify', async () => {
  const filesNum = Object.keys(artifactsData).length;

  let i = -1;
  fetch.mockImplementation(() => {
    ++i;
    if (i < 2)
      return new Response(
        JSON.stringify({ status: '0', result: 'Contract source code already verified' })
      );
    if (i < filesNum) return new Response(JSON.stringify({ status: '1', result: `guid${i}` }));

    if (i < 1.5 * filesNum)
      return new Response(JSON.stringify({ status: '0', result: 'Pending in queue' }));

    return new Response(JSON.stringify({ status: '1', result: 'Pass - Verified' }));
  });

  const logger = {
    log: jest.fn()
  };

  const promise = postToVerify(artifactsData, flattenedContracts, constructorData, {
    apiUrl,
    apiKey: '<your etherscan api key>',
    optimizer: { enabled: true, run: 200 },
    network: NETWORK_NAME,
    delay: 0,
    logger
  });

  const result = await promise;

  expect(replaceCWD(result)).toMatchSnapshot('Final result');

  expect(fetch.mock.calls).toMatchSnapshot('Fetch calls');

  const fetchReturns = fetch.mock.results.map(({ value: response }) => JSON.parse(response.body));
  expect(fetchReturns).toMatchSnapshot('Fetch returns');

  expect(logger.log.mock.calls).toMatchSnapshot('Log calls');
});
