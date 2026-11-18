// Integrate samples into 24 kHz bins, independently of the device's clock.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.frame = new Int16Array(480)
    this.index = 0
    this.ratio = sampleRate / 24000
    this.remaining = this.ratio
    this.sum = 0
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (const sample of channel) {
      let weight = 1
      while (weight > 0.000001) {
        const used = Math.min(weight, this.remaining)
        this.sum += sample * used
        this.remaining -= used
        weight -= used
        if (this.remaining <= 0.000001) {
          this.frame[this.index++] = Math.round(Math.max(-1, Math.min(1, this.sum / this.ratio)) * 32767)
          this.sum = 0
          this.remaining = this.ratio
          if (this.index === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer])
            this.frame = new Int16Array(480)
            this.index = 0
          }
        }
      }
    }
    return true
  }
}
registerProcessor('voice-capture', VoiceCapture)
