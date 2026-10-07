/**
 * The National Weather Service read port (https://api.weather.gov). No key
 * needed — NWS only requires a descriptive User-Agent header, which is set
 * here. Fully read-only.
 *
 * Two-step lookup per call: /points/{lat},{lon} resolves to the gridpoint
 * forecast URLs, then the forecast (or hourly forecast) is fetched. Only
 * fields the agent reads are declared. Every method degrades to an empty
 * list when NWS is unreachable — never throws through the caller.
 */

import { getJson, type HttpGetOptions } from "./http";

const BASE_URL = "https://api.weather.gov";
/** NWS's terms of use ask for a descriptive User-Agent. */
const USER_AGENT = "sports-agent (contact: local)";

export interface NwsPeriod {
  readonly name: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly temperature: number;
  readonly temperatureUnit: string;
  /** e.g. "5 to 10 mph" — NWS reports wind as a string range. */
  readonly windSpeed: string;
  readonly windDirection?: string;
  readonly shortForecast: string;
  readonly detailedForecast?: string;
}

export interface NwsClient {
  /** 12-hour periods for ~7 days ahead at a lat/lon (stadium coords come from the caller). */
  getForecast(latitude: number, longitude: number): Promise<readonly NwsPeriod[]>;
  /** Hour-by-hour periods for ~7 days ahead. */
  getHourlyForecast(latitude: number, longitude: number): Promise<readonly NwsPeriod[]>;
}

export interface NwsClientOptions extends HttpGetOptions {
  readonly baseUrl?: string;
}

interface PointsResponse {
  readonly properties?: {
    readonly forecast?: string;
    readonly forecastHourly?: string;
  };
}

interface ForecastResponse {
  readonly properties?: {
    readonly periods?: NwsPeriod[];
  };
}

export function createNwsClient(options: NwsClientOptions = {}): NwsClient {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const httpOptions: HttpGetOptions = {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    headers: { "user-agent": USER_AGENT },
  };

  async function getPeriods(forecastUrl: string | undefined): Promise<readonly NwsPeriod[]> {
    if (!forecastUrl) return [];
    const response = await getJson<ForecastResponse>(forecastUrl, httpOptions);
    return response?.data.properties?.periods ?? [];
  }

  async function getForecastUrls(latitude: number, longitude: number): Promise<PointsResponse["properties"] | undefined> {
    const response = await getJson<PointsResponse>(`${baseUrl}/points/${latitude},${longitude}`, httpOptions);
    return response?.data.properties;
  }

  return {
    async getForecast(latitude: number, longitude: number): Promise<readonly NwsPeriod[]> {
      return getPeriods((await getForecastUrls(latitude, longitude))?.forecast);
    },

    async getHourlyForecast(latitude: number, longitude: number): Promise<readonly NwsPeriod[]> {
      return getPeriods((await getForecastUrls(latitude, longitude))?.forecastHourly);
    },
  };
}
