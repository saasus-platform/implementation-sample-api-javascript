import { Router, Request, Response, NextFunction } from "express";
import { AuthClient, AuthMiddleware, PricingClient } from "saasus-sdk";
import type { PricingPlan } from "saasus-sdk/dist/generated/Pricing";

const router = Router();

router.use(AuthMiddleware);

// --- 認可ヘルパー --------------------------------------------------------
function hasBillingAccess(userInfo: any, tenantId: string): boolean {
  return (
    userInfo?.tenants?.some(
      (t: any) =>
        t.id === tenantId &&
        t.envs?.some((env: any) =>
          env.roles?.some(
            (r: any) => r.role_name === "admin" || r.role_name === "sadmin"
          )
        )
    ) ?? false
  );
}


// --- 課金計算用ユーティリティ -------------------------------------------
type Tier = { to: number; inf: boolean; flatAmount: number; unitPrice: number };

function extractTiers(u: any): Tier[] {
  return (u.tiers ?? []).map((m: any) => ({
    to: Number(m.up_to ?? 0),
    inf: Boolean(m.inf),
    flatAmount: Number(m.flat_amount ?? 0),
    unitPrice: Number(m.unit_amount ?? 0),
  }));
}

function calcTiered(count: number, unitDict: any): number {
  const tiers = extractTiers(unitDict);
  let last: Tier | undefined;
  for (const t of tiers) {
    last = t;
    if (t.inf || count <= t.to) {
      return t.flatAmount + count * t.unitPrice;
    }
  }
  return last ? last.flatAmount + count * last.unitPrice : 0;
}

function calcTieredUsage(count: number, unitDict: any): number {
  const tiers = extractTiers(unitDict);
  let total = 0;
  let prev = 0;
  for (const t of tiers) {
    if (count <= prev) break;
    const usage = t.inf ? count - prev : Math.min(count, t.to) - prev;
    total += t.flatAmount + usage * t.unitPrice;
    prev = t.to;
  }
  return total;
}

function calculateAmountByUnitType(count: number, unitDict: any): number {
  const unitType = unitDict.type ?? 'usage';
  const price = Number(unitDict.unit_amount ?? 0);
  switch (unitType) {
    case 'fixed':
      return price;
    case 'usage':
      return count * price;
    case 'tiered':
      return calcTiered(count, unitDict);
    case 'tiered_usage':
      return calcTieredUsage(count, unitDict);
    default:
      return count * price;
  }
}

/**
 * calculateMeteringUnitBillings — Extracted core method so it can be unit‑tested
 * and reused from jobs / CLI etc.
 */
export async function calculateMeteringUnitBillings(
  tenantId: string,
  periodStart: number,
  periodEnd: number,
  plan: any,
  pricingCli: PricingClient,
) {
  const meteringApi = pricingCli.meteringApi;

  const billings: any[] = [];
  const currencySum: Record<string, number> = {};
  const usageCache: Record<string, number> = {};

  for (const menu of plan.pricing_menus ?? []) {
    const menuName = menu.display_name;
    for (const unit of menu.units ?? []) {
      const unitName = unit.metering_unit_name ?? '';
      const unitType = unit.type ?? 'usage';
      const aggUsage = unit.aggregate_usage ?? 'sum';

      let count = usageCache[unitName] ?? 0;
      if (unitType !== 'fixed' && count === 0) {
        const resp = await meteringApi.getMeteringUnitDateCountByTenantIdAndUnitNameAndDatePeriod(
          tenantId,
          unitName,
          periodStart,
          periodEnd,
        );
        const counts = resp.data.counts ?? [];
        count = aggUsage === 'max'
          ? Math.max(0, ...counts.map((c: any) => c.count))
          : counts.reduce((acc: number, c: any) => acc + c.count, 0);
        usageCache[unitName] = count;
      }

      const amount = calculateAmountByUnitType(count, unit);
      const currency = unit.currency ?? '';
      const dispName = unit.display_name ?? '';

      billings.push({
        metering_unit_name: unitName,
        metering_unit_type: unitType,
        function_menu_name: menuName,
        period_count: count,
        currency,
        period_amount: amount,
        pricing_unit_display_name: dispName,
      });
      currencySum[currency] = (currencySum[currency] ?? 0) + amount;
    }
  }

  const totals = Object.keys(currencySum).sort().map((c) => ({
    currency: c,
    total_amount: currencySum[c],
  }));

  return { billings, totals };
}

/**
 * プランに年単位ユニットが含まれるか判定
 * @param plan - PricingPlan オブジェクト
 * @returns true: anyOf のいずれかが recurring_interval="year"
 */
function planHasYearUnit(plan: PricingPlan): boolean {
  for (const menu of plan.pricing_menus || []) {
    for (const unit of menu.units || []) {
      const inst = (unit as any).actual_instance || unit;
      if ((inst as any).recurring_interval === "year") {
        return true;
      }
    }
  }
  return false;
}

/**
 * GET /billing/dashboard
 * 指定テナント／プラン／期間の課金ダッシュボードを返却
 */
router.get('/billing/dashboard', async (req: Request, res: Response) => {
  try {
    // userInfo 取得（AuthMiddleware で付与）
    const userInfo = req.userInfo;
    if (!userInfo) return res.status(401).json({ message: 'Unauthenticated' });

    // SDK クライアント生成
    const authCli = new AuthClient();
    const pricingCli = new PricingClient();

    // クエリパラメータ
    const tenantId = String(req.query.tenant_id);
    const planId = String(req.query.plan_id);
    const periodStart = Number(req.query.period_start);
    const periodEnd = Number(req.query.period_end);

    if (!hasBillingAccess(userInfo, tenantId)) {
      return res.status(403).json({ message: 'Insufficient permissions' });
    }

    // テナント / プラン情報
    const tenant = (await authCli.tenantApi.getTenant(tenantId)).data;
    const plan = (await pricingCli.pricingPlansApi.getPricingPlan(planId)).data;

    // プラン履歴から税率
    const hist = [...(tenant.plan_histories ?? [])]
      .sort((a, b) => a.plan_applied_at - b.plan_applied_at)
      .reverse()
      .find((h) => h.plan_id === planId && h.plan_applied_at <= periodStart);

    let taxRate: any = null;
    if (hist?.tax_rate_id) {
      const taxRates = (await pricingCli.taxRateApi.getTaxRates()).data;
      taxRate = taxRates.tax_rates.find((t: any) => t.id === hist.tax_rate_id) ?? null;
    }

    // 課金計算
    const { billings, totals } = await calculateMeteringUnitBillings(
      tenantId,
      periodStart,
      periodEnd,
      plan,
      pricingCli,
    );

    // レスポンス
    res.json({
      summary: {
        total_by_currency: totals,
        total_metering_units: billings.length,
      },
      metering_unit_billings: billings,
      pricing_plan_info: {
        plan_id: planId,
        display_name: plan.display_name,
        description: plan.description,
      },
      tax_rate: taxRate,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error', error: String(err) });
  }
});

/**
 * GET /billing/plan_periods
 * テナントのプラン適用履歴 → 月／年ごとに分割した期間リストを返却
 */
router.get("/billing/plan_periods", async (req: Request, res: Response) => {
  const tenantId = String(req.query.tenant_id || "");
  if (!tenantId) {
    return res.status(400).json({ detail: "tenant_id required" });
  }

  try {
    const userInfo = req.userInfo!;
    if (!hasBillingAccess(userInfo, tenantId)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // SDK 呼び出し準備
    const authCli = new AuthClient();
    const pricingCli = new PricingClient();

    // テナント情報取得
    const tenant = (await authCli.tenantApi.getTenant(tenantId)).data;

    // 適用履歴を適用日時升順にソート
    const histories = tenant.plan_histories || [];
    histories.sort((a, b) => a.plan_applied_at! - b.plan_applied_at!);

    // 最終エッジ時刻（current_plan_period_end or 現在時刻）
    const nowSec = Math.floor(Date.now() / 1000);
    const fixedLast = tenant.current_plan_period_end || nowSec;

    // 日本語・東京時間フォーマッター
    const formatter = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const results: any[] = [];

    // 各履歴エッジで期間を分割
    for (let i = 0; i < histories.length; i++) {
      const edge = histories[i];
      const pid = edge.plan_id!;
      if (!pid) continue;

      // プラン取得＆年払い判定
      const plan = (await pricingCli.pricingPlansApi.getPricingPlan(pid)).data;
      const yearly = planHasYearUnit(plan);

      const startSec = edge.plan_applied_at!;
      const endSec =
        i + 1 < histories.length
          ? histories[i + 1].plan_applied_at! - 1
          : fixedLast;

      let cur = new Date(startSec * 1000);
      const endDate = new Date(endSec * 1000);

      // 月 or 年単位でセグメント生成
      while (cur.getTime() <= endDate.getTime()) {
        const next = new Date(cur);
        if (yearly) next.setFullYear(next.getFullYear() + 1);
        else next.setMonth(next.getMonth() + 1);

        let segEnd = new Date(next.getTime() - 1000);
        if (segEnd > endDate) segEnd = endDate;
        if (segEnd <= cur) break;

        results.push({
          // ラベル例: "2025年07月01日 00:00:00 ～ 2025年07月31日 23:59:59"
          label: `${formatter.format(cur)} ～ ${formatter.format(segEnd)}`,
          plan_id: pid,
          start: Math.floor(cur.getTime() / 1000),
          end: Math.floor(segEnd.getTime() / 1000),
        });

        if (segEnd.getTime() === endDate.getTime()) break;
        cur = new Date(segEnd.getTime() + 1000);
      }
    }

    // 降順ソートして返却
    results.sort((a, b) => b.start - a.start);
    res.json(results);
  } catch (e: any) {
    console.error("[plan_periods]", e);
    res.status(500).json({ detail: "plan periods failed" });
  }
});

/**
 * POST /billing/metering/:tenantId/:unit/:ts
 * 指定タイムスタンプでのメータリング数を更新
 */
router.post(
  "/billing/metering/:tenantId/:unit/:ts",
  async (req: Request, res: Response) => {
    const { tenantId, unit, ts } = req.params;
    const { method, count } = req.body as {
      method: "add" | "sub" | "direct";
      count: number;
    };

    // メソッド & カウントのバリデーション
    if (!["add", "sub", "direct"].includes(method) || count < 0) {
      return res.status(400).json({ detail: "invalid method / count" });
    }

    try {
      const pricingCli = new PricingClient();
      const resp =
        await pricingCli.meteringApi.updateMeteringUnitTimestampCount(
          tenantId,
          unit,
          parseInt(ts, 10),
          { method, count }
        );
      res.json(resp.data);
    } catch (e: any) {
      console.error("[updateMetering]", e);
      res.status(500).json({ detail: "meter update failed" });
    }
  }
);

/**
 * POST /billing/metering/:tenantId/:unit
 * 現在日時のタイムスタンプでのメータリング数を更新
 */
router.post(
  "/billing/metering/:tenantId/:unit",
  async (req: Request, res: Response) => {
    const { tenantId, unit, ts } = req.params;
    const { method, count } = req.body as {
      method: "add" | "sub" | "direct";
      count: number;
    };

    // メソッド & カウントのバリデーション
    if (!["add", "sub", "direct"].includes(method) || count < 0) {
      return res.status(400).json({ detail: "invalid method / count" });
    }

    try {
      const pricingCli = new PricingClient();
      const resp =
        await pricingCli.meteringApi.updateMeteringUnitTimestampCountNow(
          tenantId,
          unit,
          { method, count }
        );
      res.json(resp.data);
    } catch (e: any) {
      console.error("[updateMetering]", e);
      res.status(500).json({ detail: "meter update failed" });
    }
  }
);
export default router;
