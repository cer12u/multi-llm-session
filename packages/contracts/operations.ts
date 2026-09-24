import type { ModelProfile, PublicAgent, PublicSession, RunKind } from './index.js';

export type ProviderHealth = {scope:string;state:string;failures:number;lastError:string|null;retryAt:number|null;probeUntil:number|null};
export type ProviderReport = {
  profile:ModelProfile;hash:string;health:ProviderHealth;liveEnabled:boolean;
  credentialConfiguredOnCore:boolean;credentialError:string|null;
  usageObserved:{calls:number;inputKnown:number;outputKnown:number};
};
export const operationLabels = {
  SESSION_ENDED:'セッション終了',AGENT_DISABLED:'Agent停止中',BUDGET_STOPPED:'実行予算の上限で停止',
  SESSION_PAUSED:'人間の操作で一時停止',NOT_STARTED:'開始前',LIVE_DISABLED:'実モデルの実行が無効',
  WORKER_OFFLINE:'Worker未接続',AUTH_ERROR:'Provider認証エラー',CONFIG_ERROR:'Provider設定エラー',
  RATE_LIMIT:'Providerの利用制限で待機',PROVIDER_OPEN:'Provider障害の復旧待ち',PROVIDER_PROBE:'Providerの単一probeを実行中',
  RETRY_EXHAUSTED:'Agentの再試行上限',RETRY_WAIT:'再試行の待機中',
  THINKING:'参加を判断中',GENERATING:'発言候補を生成中',REVIEWING:'発言候補を再確認中',
  REMEMBERING:'記憶を整理中',OBSERVING:'発言せず入力を観測中',WAITING_CANDIDATE:'発言候補の確定待ち',
  WAITING_REPLY:'指名した相手の返答待ち',DEFERRED:'本人が発言を保留',COOLDOWN:'発言後の待機',
  CONTENT_LOOP:'本人が反復を避けて保留・沈黙中',
  WAITING_INPUT:'新着入力の処理待ち',QUIET:'本人は静かに待機中',
} as const;
export type OperationReason = keyof typeof operationLabels;
export type AgentOperation = {
  agent:PublicAgent;frozen:ProviderReport;latestVersion:number;reason:OperationReason;
  lastError:string|null;errorCount:number;nextOpportunityAt:number|null;waitingFor:string|null;
  activeRun:RunKind|null;candidateState:string|null;observationPending:number;memoryPending:number;
};
export type Operations = {schemaVersion:1;now:number;session:PublicSession;agents:AgentOperation[]};
