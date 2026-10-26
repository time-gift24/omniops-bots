import { motionTokens } from "@/components/arc/motion-tokens"
export const EASE_OUT = [...motionTokens.ease.enter] as [
  number,
  number,
  number,
  number,
]
export const EASE_IN_OUT = [...motionTokens.ease.inOut] as [
  number,
  number,
  number,
  number,
]
export const SPRING_PANEL = motionTokens.spring.smooth
export const SPRING_LAYOUT = motionTokens.spring.morph
export const SPRING_GLIDE = motionTokens.spring.morph
export const SPRING_PRESS = motionTokens.spring.snappy
export const SPRING_SWAP = motionTokens.spring.snappy
export const SPRING_MODAL = motionTokens.spring.smooth
