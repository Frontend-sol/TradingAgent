export type OkxEnv = "demo" | "live";

export interface OkxCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface OkxCandle {
  ts: string;
  o: string;
  h: string;
  l: string;
  c: string;
  vol: string;
}

export interface OkxOrderRequest {
  instId: string;
  tdMode: "cash" | "cross" | "isolated";
  side: "buy" | "sell";
  ordType: "market" | "limit";
  sz: string;
  px?: string;
  reduceOnly?: boolean;
  tpTriggerPx?: string;
  tpOrdPx?: string;
  slTriggerPx?: string;
  slOrdPx?: string;
  attachAlgoOrds?: Array<{
    slTriggerPx?: string;
    slOrdPx?: string;
    slTriggerPxType?: "last" | "index" | "mark";
  }>;
}

export interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}
