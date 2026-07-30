import { Request } from 'express'
import { AuthClient, PricingClient } from 'saasus-sdk'

export function getClientHeaders(req: Request) {
  return {
    referer: (req.headers['referer'] as string) || '',
    xSaaSusReferer: (req.headers['x-saasus-referer'] as string) || '',
    xSaaSusTraceId: (req.headers['x-saasus-trace-id'] as string) || '',
  }
}

export function createAuthClient(req: Request): AuthClient {
  const { referer, xSaaSusReferer, xSaaSusTraceId } = getClientHeaders(req)
  return new AuthClient(referer, xSaaSusReferer, xSaaSusTraceId)
}

export function createPricingClient(req: Request): PricingClient {
  const { referer, xSaaSusReferer, xSaaSusTraceId } = getClientHeaders(req)
  return new PricingClient(referer, xSaaSusReferer, xSaaSusTraceId)
}
