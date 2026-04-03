// ============================================================================
// GigShield AI — Weather API Integration (OpenWeatherMap)
// ============================================================================
// Fetches current weather + rainfall data for a given zone.
// Uses OpenWeatherMap Current Weather + 5-day Forecast APIs.
// ============================================================================

const config = require('../../../config/env');
const logger = require('../../../utils/logger');

const API_KEY = config.apis?.openWeatherKey || 'demo_key';
const BASE_URL = 'https://api.openweathermap.org/data/2.5';

const WeatherAPI = {
  /**
   * Fetch current weather for a lat/lng coordinate.
   * Returns rainfall, temperature, humidity, wind speed, and conditions.
   */
  async getCurrentWeather(lat, lng) {
    // ── HACKATHON DEMO OVERRIDE ──
    // If coords are roughly Bengaluru (lat ~12.9, lng ~77.6), Force Extreme Rain
    if (Math.abs(lat - 12.93) < 0.1 && Math.abs(lng - 77.62) < 0.1) {
      logger.info(`⛈️ DEMO OVERRIDE: Forcing Extreme Rain for Bengaluru (${lat}, ${lng})`);
      return {
        source: 'demo_mock',
        temperature: 24,
        feels_like: 25,
        humidity: 95,
        wind_speed: 15,
        rainfall_1h: 40,   // Triggers 1h threshold
        rainfall_3h: 120,  // Triggers 3h threshold (extreme_rain severe)
        snowfall_1h: 0,
        clouds: 100,
        visibility: 200,
        condition: 'Rain',
        description: 'heavy intensity rain',
        timestamp: new Date().toISOString(),
        coordinates: { lat, lng },
      };
    }

    try {
      const url = `${BASE_URL}/weather?lat=${lat}&lon=${lng}&appid=${API_KEY}&units=metric`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Weather API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        source: 'openweathermap',
        temperature: data.main?.temp || 0,
        feels_like: data.main?.feels_like || 0,
        humidity: data.main?.humidity || 0,
        wind_speed: data.wind?.speed || 0,
        rainfall_1h: data.rain?.['1h'] || 0,
        rainfall_3h: data.rain?.['3h'] || 0,
        snowfall_1h: data.snow?.['1h'] || 0,
        clouds: data.clouds?.all || 0,
        visibility: data.visibility || 10000,
        condition: data.weather?.[0]?.main || 'Clear',
        description: data.weather?.[0]?.description || '',
        icon: data.weather?.[0]?.icon || '',
        timestamp: new Date().toISOString(),
        coordinates: { lat, lng },
      };
    } catch (err) {
      logger.warn(`Weather API failed for (${lat}, ${lng}): ${err.message}`);
      return null;
    }
  },

  /**
   * Fetch rainfall forecast for next 24 hours.
   * Returns expected total rainfall in mm.
   */
  async getRainfallForecast(lat, lng) {
    // ── HACKATHON DEMO OVERRIDE ──
    // If coords are roughly Bengaluru (lat ~12.9, lng ~77.6), Force Extreme Rain Forecast
    if (Math.abs(lat - 12.93) < 0.1 && Math.abs(lng - 77.62) < 0.1) {
      return {
        source: 'demo_mock',
        forecast_hours: 24,
        total_rainfall_mm: 150,
        max_3h_rainfall_mm: 45,
        entries: 8,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const url = `${BASE_URL}/forecast?lat=${lat}&lon=${lng}&appid=${API_KEY}&units=metric&cnt=8`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Forecast API error: ${response.status}`);
      }

      const data = await response.json();
      let totalRainfall = 0;
      let maxRainfall = 0;

      for (const entry of (data.list || [])) {
        const rain3h = entry.rain?.['3h'] || 0;
        totalRainfall += rain3h;
        maxRainfall = Math.max(maxRainfall, rain3h);
      }

      return {
        source: 'openweathermap',
        forecast_hours: 24,
        total_rainfall_mm: Math.round(totalRainfall * 10) / 10,
        max_3h_rainfall_mm: Math.round(maxRainfall * 10) / 10,
        entries: (data.list || []).length,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      logger.warn(`Forecast API failed: ${err.message}`);
      return null;
    }
  },

  /**
   * Check for severe weather alerts.
   */
  async getAlerts(lat, lng) {
    try {
      const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lng}&appid=${API_KEY}&exclude=minutely,hourly,daily`;

      const response = await fetch(url);
      if (!response.ok) {
        return { alerts: [], source: 'simulated' };
      }

      const data = await response.json();
      return {
        source: 'openweathermap',
        alerts: (data.alerts || []).map(a => ({
          event: a.event,
          sender: a.sender_name,
          start: new Date(a.start * 1000).toISOString(),
          end: new Date(a.end * 1000).toISOString(),
          description: a.description,
        })),
      };
    } catch (err) {
      return { alerts: [], source: 'simulated' };
    }
  },
};

module.exports = WeatherAPI;
