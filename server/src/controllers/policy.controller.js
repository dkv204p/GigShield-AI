// ============================================================================
// GigShield AI — Policy Controller
// ============================================================================

const PolicyModel = require('../models/policy.model');
const PaymentModel = require('../models/payment.model');
const UserModel = require('../models/user.model');
const RazorpayService = require('../services/razorpay.service');
const { query } = require('../config/db');
const logger = require('../utils/logger');
const { getCurrentWeekRange, getNextWeekRange, getPayoutAmount } = require('../utils/helpers');

const PolicyController = {
  /**
   * POST /api/v1/policies
   * Create a new weekly insurance policy
   */
  async create(req, res, next) {
    try {
      const { coverage_tier, disruption_type, week = 'current' } = req.body;
      const workerId = req.user.id;

      // Get worker's zone
      const worker = await UserModel.findById(workerId);
      if (!worker.zone_id) {
        return res.status(400).json({
          success: false,
          message: 'Please select a work zone before purchasing a policy.',
        });
      }

      // Determine week range
      const weekRange = week === 'next' ? getNextWeekRange() : getCurrentWeekRange();

      // Check for duplicate policy
      const existing = await PolicyModel.checkDuplicate(
        workerId, disruption_type, weekRange.weekStart, weekRange.weekEnd
      );
      if (existing) {
        return res.status(409).json({
          success: false,
          message: `You already have an active ${disruption_type} policy for this week.`,
        });
      }

      // Calculate dynamic premium with factors
      const { premium: premiumAmount, breakdown } = calculateDynamicPremium(
        coverage_tier, 
        disruption_type, 
        worker.risk_tier,
        worker.city // Passed to simulate city-based dynamic weather/aqi
      );

      // Create policy
      const policy = await PolicyModel.create({
        worker_id: workerId,
        zone_id: worker.zone_id,
        coverage_tier,
        disruption_type,
        premium_amount: premiumAmount,
        week_start: weekRange.weekStart,
        week_end: weekRange.weekEnd,
        pricing_factors: {
          zone_risk_tier: worker.risk_tier,
          coverage_tier,
          disruption_type,
          base_premium: breakdown.find(b => b.type === 'base').amount,
          dynamic_breakdown: breakdown,
          model_version: 'v2.0-dynamic',
        },
      });

      // Create payment record
      const payment = await PaymentModel.createPremiumPayment({
        worker_id: workerId,
        policy_id: policy.id,
        amount: premiumAmount,
      });

      // Generate Live Razorpay Order
      const order = await RazorpayService.createOrder({
        amount: premiumAmount,
        receipt: payment.transaction_ref,
        notes: { policy_id: policy.id, worker_id: workerId }
      });

      // Link Razorpay order ID to payment record
      await query(`UPDATE payments SET razorpay_order_id = $1 WHERE id = $2`, [order.id, payment.id]);

      logger.info(`Policy pending payment: ${policy.policy_number} — ₹${premiumAmount} (${disruption_type})`);

      res.status(201).json({
        success: true,
        message: 'Policy created. Proceed to payment.',
        data: {
          policy,
          payment: {
            id: payment.id,
            transaction_ref: payment.transaction_ref,
            amount: payment.amount,
          },
          razorpay_order_id: order.id,
          amount: premiumAmount,
          currency: 'INR',
          key_id: process.env.RAZORPAY_KEY_ID
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/v1/policies
   * List worker's policies
   */
  async list(req, res, next) {
    try {
      const { page = 1, limit = 10, status } = req.query;

      const result = await PolicyModel.findByWorker(req.user.id, {
        page: parseInt(page),
        limit: parseInt(limit),
        status,
      });

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/v1/policies/active
   * Get worker's currently active policies
   */
  async getActive(req, res, next) {
    try {
      const policies = await PolicyModel.getActiveByWorker(req.user.id);

      res.json({
        success: true,
        data: {
          policies,
          total: policies.length,
          week: getCurrentWeekRange(),
        },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /api/v1/policies/:id
   * Get policy details
   */
  async getById(req, res, next) {
    try {
      const policy = await PolicyModel.findById(req.params.id);
      if (!policy) {
        return res.status(404).json({ success: false, message: 'Policy not found.' });
      }

      // Workers can only view their own policies
      if (req.user.role === 'worker' && policy.worker_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      res.json({ success: true, data: { policy } });
    } catch (err) {
      next(err);
    }
  },

  /**
   * DELETE /api/v1/policies/:id
   * Cancel a policy
   */
  async cancel(req, res, next) {
    try {
      const { reason } = req.body;
      const policy = await PolicyModel.findById(req.params.id);

      if (!policy) {
        return res.status(404).json({ success: false, message: 'Policy not found.' });
      }

      if (req.user.role === 'worker' && policy.worker_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      if (!['active', 'pending_payment'].includes(policy.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel a policy with status: ${policy.status}`,
        });
      }

      const cancelled = await PolicyModel.cancel(req.params.id, reason);

      logger.info(`Policy cancelled: ${policy.policy_number}`);

      res.json({
        success: true,
        message: 'Policy cancelled successfully.',
        data: { policy: cancelled },
      });
    } catch (err) {
      next(err);
    }
  },

  /**
   * POST /api/v1/policies/quote
   * Get a premium quote without purchasing
   */
  async getQuote(req, res, next) {
    try {
      const { coverage_tier, disruption_type, zone_id } = req.body;
      const worker = await UserModel.findById(req.user.id);
      
      let targetZoneId = zone_id || worker.zone_id;

      if (!targetZoneId) {
        return res.status(400).json({
          success: false,
          message: 'Select a work zone first to get a quote.',
        });
      }
      
      const LocationModel = require('../models/location.model');
      const targetZone = await LocationModel.findById(targetZoneId);
      
      if (!targetZone) {
        return res.status(404).json({ success: false, message: 'Zone not found' });
      }

      const { premium: premiumAmount, breakdown } = calculateDynamicPremium(
        coverage_tier, 
        disruption_type, 
        targetZone.risk_tier,
        targetZone.city
      );
      
      const payoutAmount = getPayoutAmount(coverage_tier);

      res.json({
        success: true,
        data: {
          quote: {
            coverage_tier,
            disruption_type,
            premium_amount: premiumAmount,
            pricing_breakdown: breakdown,
            payout_amount: payoutAmount,
            week: getCurrentWeekRange(),
            zone: {
              name: targetZone.zone_name,
              city: targetZone.city,
              risk_tier: targetZone.risk_tier,
            },
          },
        },
      });
    } catch (err) {
      next(err);
    }
  },
};

// ── Phase 2: Dynamic Premium Engine ──

function calculateDynamicPremium(coverageTier, disruptionType, riskTier, city) {
  let breakdown = [];
  
  // 1. Base Coverage Tier
  const basePremiums = { basic: 35, standard: 60, premium: 95 };
  let currentPremium = basePremiums[coverageTier] || 60;
  breakdown.push({ type: 'base', label: `Base (${coverageTier})`, amount: currentPremium });

  // 2. City & Weather Simulation (Mock real-time APIs)
  // In a real app we'd call WeatherAPI.getCurrent() here
  let currentAQI = 150;
  let currentRainMM = 10;
  
  if (city === 'Delhi') currentAQI = 420;
  if (city === 'Mumbai') currentRainMM = 65;
  if (city === 'Bengaluru') { currentAQI = 50; currentRainMM = 0; }

  // 3. Dynamic Adjustments (The Wow Factor)
  if (currentRainMM > 50) {
    let rainSurcharge = 15;
    currentPremium += rainSurcharge;
    breakdown.push({ type: 'weather', label: `Heavy Rain Alert (>50mm)`, amount: rainSurcharge });
  }

  if (currentAQI > 300) {
    let aqiSurcharge = 12;
    currentPremium += aqiSurcharge;
    breakdown.push({ type: 'environment', label: `Severe AQI (${currentAQI})`, amount: aqiSurcharge });
  }

  // 4. Saftey / Risk Tier Discounts
  if (riskTier === 'low') {
    let safeDiscount = -8;
    currentPremium += safeDiscount;
    breakdown.push({ type: 'safety', label: `Safe Zone Discount`, amount: safeDiscount });
  } else if (riskTier === 'high' || riskTier === 'critical') {
    let riskSurcharge = 10;
    currentPremium += riskSurcharge;
    breakdown.push({ type: 'safety', label: `High Risk Zone`, amount: riskSurcharge });
  }

  // 5. Time of Day Adjustment (Night vs Day)
  const hour = new Date().getHours();
  if (hour >= 20 || hour < 6) {
    let nightSurcharge = 5;
    currentPremium += nightSurcharge;
    breakdown.push({ type: 'time', label: `Night Shift Factor`, amount: nightSurcharge });
  }

  // Enforce guardrails: ₹30–₹150
  currentPremium = Math.max(30, Math.min(150, Math.round(currentPremium * 100) / 100));

  return { premium: currentPremium, breakdown };
}

module.exports = PolicyController;
