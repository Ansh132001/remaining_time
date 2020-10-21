import { Estimator } from './estimator'
import { RemainingCardCounts, getRemainingCardLoad, getRemainingReviews, now } from './utils'
import ankiLocalStorage from './utils/ankiLocalStorage'
import { onSameReviewSession } from './isDoingReview'
import { debugLog } from './utils/debugLog'

enum RCCTConst {
  RESET,
  UPDATE,
  IGNORE
}

interface InstReset {
  instType: RCCTConst.RESET;
}

interface InstIgnore {
  instType: RCCTConst.IGNORE;
}

export type InstLogType = 'new' | 'good' | 'again' | 'rev-good' | 'rev-again' | 'unknown'

interface InstUpdate {
  instType: RCCTConst.UPDATE;
  dy: number;
  logType: InstLogType;
}

type EstimatorInst = InstReset | InstIgnore | InstUpdate

let lastEpoch = 0

export async function updateEstimator () {
  const instruction = await processRemainingCountDiff()
  const epoch = now()
  const estimator = await Estimator.instance()

  debugLog(' - Output instruction: %s', JSON.stringify(instruction))

  // Due to how run() is called on index.ts, on desktop anki
  // run() might be called twice with qFade(100ms) duration.
  // on android this duration may goes up to 500ms.
  // This prevents them being counted as two reviews
  const isInitializing = (epoch - lastEpoch < 1)
  lastEpoch = epoch
  if (isInitializing) return

  switch (instruction.instType) {
    case RCCTConst.IGNORE:
      break

    case RCCTConst.RESET:
      estimator.reset()
      break

    case RCCTConst.UPDATE:
      estimator.update(instruction.dy, instruction.logType)
      break
  }
  estimator.save()
}

/// /

async function processRemainingCountDiff (): Promise<EstimatorInst> {
  const currentRemainingCards = await getRemainingReviews()
  try {
    const prevRemainingCards = await getRCC()
    if (!prevRemainingCards) return { instType: RCCTConst.RESET }
    const previousReviewLoad = getRemainingCardLoad(prevRemainingCards)
    const nextReviewLoad = getRemainingCardLoad(currentRemainingCards)
    const dy = previousReviewLoad - nextReviewLoad

    const { nu: nu0, lrn: lrn0, rev: rev0 } = prevRemainingCards
    const { nu: nu1, lrn: lrn1, rev: rev1 } = currentRemainingCards

    debugLog('RCC - prev: %s, current: %s', JSON.stringify(prevRemainingCards), JSON.stringify(currentRemainingCards))

    // See the new card for the first time
    if (
      // Because of 'bury related new cards' options,
      // nu1 may be decremented more than 1
      nu0 > nu1 &&
      rev0 === rev1 &&
      lrn0 <= lrn1
    ) {
      return { instType: RCCTConst.UPDATE, dy, logType: 'new' }
    }

    // Re-learn or learn the current learning card
    if (
      nu0 === nu1 &&
      rev0 === rev1
    ) {
      // This might happen also in undo scenario, but we're, quite open to such scenario.
      // some minor inaccuracies could be tolerated?
      if (lrn0 > lrn1) return { instType: RCCTConst.UPDATE, dy, logType: 'good' }
      else return { instType: RCCTConst.UPDATE, dy, logType: 'again' }
    }

    // Learning review cards
    if (
      nu0 === nu1 &&
      lrn0 <= lrn1 &&
      rev0 > rev1
    ) {
      if (lrn0 === lrn1) return { instType: RCCTConst.UPDATE, dy, logType: 'rev-good' }
      else return { instType: RCCTConst.UPDATE, dy, logType: 'rev-again' }
    }

    // maybe undo?
    if (
      (nu0 < nu1 && rev0 === rev1) ||
      (rev0 < rev1 && nu0 === nu1)
    ) {
      if (await onSameReviewSession()) {
        return { instType: RCCTConst.UPDATE, dy, logType: 'unknown' }
      }
    }

    // Reset otherwise
    return { instType: RCCTConst.RESET }
  } finally {
    saveRCC(currentRemainingCards)
  }
}

async function getRCC () {
  const s = await ankiLocalStorage.getItem('__rt__lastrcc__')
  if (!s) return null
  return JSON.parse(s) as RemainingCardCounts
}

function saveRCC (rcc: RemainingCardCounts) {
  ankiLocalStorage.setItem('__rt__lastrcc__', JSON.stringify(rcc))
}
