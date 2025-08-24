/* eslint-disable max-classes-per-file */
(() => {
  'use strict';

  // --- COMMON: UTILITIES & ABSTRACTIONS (LAYER 0) ---
  // Globally used modules like the logger and custom error types.
  const common = (() => {
    'use strict';

    // Rule: Abstract logger to comply with `no-console`.
    // In a real production environment, this should integrate with a proper logging service.
    const Logger = Object.freeze({
      info(message) { /*
       * TODO: Implement production-ready info logging.
       */ },
      error(message, error) { /*
       * TODO: Implement production-ready error logging with structured data.
       */ },
    });

    // Rule: Custom error types for explicit error propagation (MISRA/CERT).
    class ConfigurationError extends Error {
      constructor(message) {
        super(message);
        this.name = 'ConfigurationError';
      }
    }

    class ValidationError extends Error {
      constructor(message) {
        super(message);
        this.name = 'ValidationError';
      }
    }

    class NetworkError extends Error {
      constructor(message, {
        statusCode,
        cause,
      }) {
        super(message);
        this.name = 'NetworkError';
        this.statusCode = statusCode;
        this.cause = cause;
      }
    }

    return {
      Logger,
      ConfigurationError,
      ValidationError,
      NetworkError,
    };
  })();


  // --- LAYER 1: DOMAIN (Not applicable) ---
  // The Domain layer is not required as this function's purpose is to act
  // as a gateway without complex business logic or data models.


  // --- LAYER 2: APPLICATION (Use Cases) ---
  const application = (({
    Logger,
  }) => {
    'use strict';

    class FetchPOIsUseCase {
      #poiGateway;

      constructor({
        poiGateway,
      }) {
        if (!poiGateway) {
          // Rule: Constructors must validate their dependencies.
          throw new ConfigurationError('poiGateway dependency is required.');
        }
        this.#poiGateway = poiGateway;
      }

      async execute({
        query,
        rect,
        categoryGroupCode,
      }) {
        // Rule: The Application layer orchestrates the business flow.
        // Data fetching logic is fully delegated to the Gateway.
        Logger.info(`Executing FetchPOIsUseCase for query: ${query}`);
        const poiData = await this.#poiGateway.fetchPOIs({
          query,
          rect,
          categoryGroupCode,
        });
        return poiData;
      }
    }

    return {
      FetchPOIsUseCase,
    };
  })(common);


  // --- LAYER 3 & 4: INFRASTRUCTURE (Adapters, Drivers) ---
  const infrastructure = ((app, utils) => {
    'use strict';

    const {
      Logger,
      ConfigurationError,
      ValidationError,
      NetworkError,
    } = utils;
    const functions = require('firebase-functions');
    const https = require('https');
    const {
      URL,
      URLSearchParams,
    } = require('url');

    // --- DRIVERS: Environment & Configuration ---
    const getConfig = () => {
      // Rule: Read from `process.env`, which is populated by the GitHub Actions workflow `env` block.
      const {
        NAVER_CLIENT_ID: naverId,
        NAVER_CLIENT_SECRET: naverSecret,
        KAKAO_REST_API_KEY: kakaoKey,
      } = process.env;

      if (!naverId || !naverSecret || !kakaoKey) {
        Logger.error('Missing required API keys in environment configuration.');
        throw new ConfigurationError('API credentials are not configured on the server.');
      }
      return Object.freeze({
        naverId,
        naverSecret,
        kakaoKey,
      });
    };


    // --- ADAPTERS: Input Validator ---
    // Rule: Sanitize untrusted data at the boundary (CERT IDS00-J).
    const validateRequestQuery = (query) => {
      const {
        minLat,
        minLng,
        maxLat,
        maxLng,
        query: searchQuery,
        category_group_code: category,
      } = query;

      const requiredFields = {
        minLat,
        minLng,
        maxLat,
        maxLng,
        searchQuery,
        category,
      };
      // eslint-disable-next-line no-restricted-syntax
      for (const [key, value] of Object.entries(requiredFields)) {
        if (value === undefined || value === null || value === '') {
          throw new ValidationError(`Missing required parameter: ${key}`);
        }
      }

      const coords = {
        minLat,
        minLng,
        maxLat,
        maxLng,
      };
      // eslint-disable-next-line no-restricted-syntax
      for (const [key, value] of Object.entries(coords)) {
        const numValue = Number(value);
        if (Number.isNaN(numValue) || numValue < -180 || numValue > 180) {
          throw new ValidationError(`Invalid coordinate value for ${key}: ${value}`);
        }
      }

      return {
        rect: `${minLng},${minLat},${maxLng},${maxLat}`,
        searchQuery: String(searchQuery),
        category: String(category),
      };
    };

    // --- DRIVERS: Low-level HTTP Client ---
    // Rule: A robust HTTP request client that enforces timeouts, resource management,
    // and strict nesting depth rules.
    const getRequest = ({
      fullUrl,
      headers,
      timeout = 3000,
    }) => new Promise((resolve, reject) => {
      const {
        hostname,
        pathname,
        search,
      } = new URL(fullUrl);
      const options = {
        hostname,
        path: pathname + search,
        method: 'GET',
        headers,
        timeout, // Rule: Set a timeout on external dependencies to prevent DoS.
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data));
            } else {
              // Rule: Explicitly throw a typed error on failure. Do not swallow errors.
              reject(new NetworkError(`API request failed with status code ${res.statusCode}`, {
                statusCode: res.statusCode,
                cause: data,
              }));
            }
          } catch (e) {
            reject(new NetworkError('Failed to parse API response JSON.', {
              cause: e,
            }));
          }
        });
      });

      // Rule: Explicitly handle all error paths and clean up resources (MISRA/CERT).
      req.on('error', (err) => {
        req.abort();
        reject(new NetworkError('HTTP request encountered an error.', {
          cause: err,
        }));
      });
      req.on('timeout', () => {
        req.abort();
        reject(new NetworkError(`HTTP request timed out after ${timeout}ms.`));
      });

      req.end();
    });


    // --- ADAPTERS: GATEWAY (External API Orchestrator) ---
    class POIGateway {
      #config;

      #KAKAO_TO_NAVER_CATEGORY_MAP = {
        /*
         * TODO: Map Kakao category codes to Naver keywords
         */
      };

      constructor({
        config,
      }) {
        this.#config = config;
      }

      // Rule: Private helper methods for single responsibility.
      async #callNaverApi({
        query,
      }) {
        const headers = {
          'X-Naver-Client-Id': this.#config.naverId,
          'X-Naver-Client-Secret': this.#config.naverSecret,
        };
        const params = new URLSearchParams({
          query,
          display: 5,
        });
        const fullUrl = `https://openapi.naver.com/v1/search/local.json?${params.toString()}`;
        const response = await getRequest({
          fullUrl,
          headers,
        });
        return response.items || [];
      }

      async #callKakaoApi({
        query,
        rect,
        categoryGroupCode,
      }) {
        const headers = {
          Authorization: `KakaoAK ${this.#config.kakaoKey}`,
        };
        const params = new URLSearchParams({
          query,
          rect,
          category_group_code: categoryGroupCode,
          size: 15,
        });
        const fullUrl = `https://dapi.kakao.com/v2/local/search/keyword.json?${params.toString()}`;
        const response = await getRequest({
          fullUrl,
          headers,
        });
        return response.documents || [];
      }

      async fetchPOIs({
        query,
        rect,
        categoryGroupCode,
      }) {
        const naverQueryKeyword = this.#KAKAO_TO_NAVER_CATEGORY_MAP[categoryGroupCode] || '';
        const naverQuery = `${query} ${naverQueryKeyword}`.trim();

        // Rule: Do not swallow errors. `Promise.all` fails fast, propagating the error
        // to the controller which is responsible for handling it.
        const [naverPOIs, kakaoPOIs] = await Promise.all([
          this.#callNaverApi({
            query: naverQuery,
          }),
          this.#callKakaoApi({
            query,
            rect,
            categoryGroupCode,
          }),
        ]);

        return {
          naver_data: naverPOIs,
          kakao_data: kakaoPOIs,
        };
      }
    }


    // --- ADAPTERS: CONTROLLER (API Endpoint Handler) ---
    class APIController {
      #fetchPOIsUseCase;

      constructor({
        fetchPOIsUseCase,
      }) {
        if (!fetchPOIsUseCase) {
          throw new ConfigurationError('fetchPOIsUseCase dependency is required.');
        }
        this.#fetchPOIsUseCase = fetchPOIsUseCase;
      }

      handleRequest = async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*'); // For production, specify allowed origins.
        res.set('Content-Type', 'application/json; charset=utf-8');

        try {
          const {
            rect,
            searchQuery,
            category,
          } = validateRequestQuery(req.query);
          const data = await this.#fetchPOIsUseCase.execute({
            query: searchQuery,
            rect,
            categoryGroupCode: category,
          });
          return res.status(200).send(JSON.stringify({
            success: true,
            data,
          }));
        } catch (error) {
          // Rule: Handle errors explicitly and provide safe, generic responses (OWASP).
          Logger.error('API request failed in controller', error);

          if (error instanceof ValidationError) {
            return res.status(400).send(JSON.stringify({
              success: false,
              error: {
                type: 'Bad Request',
                message: error.message,
              },
            }));
          }
          if (error instanceof NetworkError) {
            return res.status(503).send(JSON.stringify({
              success: false,
              error: {
                type: 'Service Unavailable',
                message: 'An external service is temporarily unavailable.',
              },
            }));
          }
          // Includes ConfigurationError and any other unexpected errors.
          return res.status(500).send(JSON.stringify({
            success: false,
            error: {
              type: 'Internal Server Error',
              message: 'An unexpected error occurred.',
            },
          }));
        }
      };
    }

    // --- DRIVERS: ROUTER ---
    // Rule: A single function must act as a scalable router for multiple paths.
    const createRouter = ({
      apiController,
    }) => (req, res) => {
      const path = req.path.split('?')[0];

      switch (path) {
        case '/pois':
          apiController.handleRequest(req, res);
          break;

          // --- Example for future route expansion ---
          /*
          case '/users':
            userController.handleRequest(req, res);
            break;
          */

        default:
          res.status(404).send(JSON.stringify({
            success: false,
            error: {
              type: 'Not Found',
              message: 'The requested endpoint does not exist.',
            },
          }));
          break;
      }
    };


    // --- COMPOSITION ROOT ---
    // The single place where all objects are constructed and dependencies are wired.
    const composeApp = () => {
      try {
        const config = getConfig(); // 1. Load configuration (throws on failure).
        const poiGateway = new POIGateway({
          config,
        });
        const fetchPOIsUseCase = new app.FetchPOIsUseCase({
          poiGateway,
        });
        const apiController = new APIController({
          fetchPOIsUseCase,
        });

        // 2. Create the router and inject controllers.
        const router = createRouter({
          apiController,
        });

        return {
          router,
          initializationError: null,
        };
      } catch (error) {
        // This catches errors during the app setup (e.g., missing env vars).
        Logger.error('Failed to compose application.', error);
        return {
          router: null,
          initializationError: error,
        };
      }
    };

    const {
      router,
      initializationError,
    } = composeApp();

    const mainHandler = (req, res) => {
      // If the app failed to initialize, all requests will fail safely.
      if (initializationError) {
        res.status(500).send(JSON.stringify({
          success: false,
          error: {
            type: 'Configuration Error',
            message: 'The server is not configured correctly.',
          },
        }));
        return;
      }
      // Delegate all requests to the router.
      router(req, res);
    };


    return {
      mainHandler,
    };
  })(application, common);

  // --- FRAMEWORK EXPORT ---
  // The final export, specifying the Iowa region (`us-central1`).
  exports.api = functions.region('us-central1').https.onRequest(infrastructure.mainHandler);
})();
