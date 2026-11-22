/**
 * See-through with Fade out over a still wallpaper: the fade's steps are
 * copies of the picture blurred once, ahead of time, not frosted layers. The
 * compositor blurred those again on every frame anything frosted moved over
 * them, and scrolling a long chat (its top and foot veils are frosted) dropped
 * frames. One of Eaon's own wallpapers, so the test needs no desktop.
 */
import assert from 'node:assert/strict'
import { scenario } from './fixtures.mjs'

scenario('See-through Fade out over a still picture is baked, not blurred again as the page moves', { timeout: 120_000 }, async (s) => {
  const app = await s.launch()
  const page = app.page
  await page.eval(async () => {
    const { appearance } = await window.api.settings.get()
    await window.api.settings.patch({
      appearance: { ...appearance, seeThrough: { ...appearance.seeThrough, enabled: true, source: 'eaon', style: 'photo', fade: true } }
    })
  })
  await page.reload()

  await page.waitFor(() => document.querySelectorAll('.see-through[data-ready] .see-through__baked-shift > canvas').length === 6, {
    timeout: 30_000,
    message: 'the six steps of Fade out, baked'
  })
  const fade = await page.eval(() => {
    const layer = /** @type {HTMLElement} */ (document.querySelector('.see-through__layer'))
    const shifts = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.see-through__baked-shift')])
    // Each copy holds picture, not nothing: its middle, drawn small, is opaque.
    const opaque = shifts.map((shift) => {
      const copy = /** @type {HTMLCanvasElement} */ (shift.firstElementChild)
      const probe = document.createElement('canvas')
      probe.width = probe.height = 4
      const ctx = /** @type {CanvasRenderingContext2D} */ (probe.getContext('2d'))
      ctx.drawImage(copy, copy.width / 2 - 2, copy.height / 2 - 2, 4, 4, 0, 0, 4, 4)
      return ctx.getImageData(1, 1, 1, 1).data[3] === 255
    })
    return {
      frosted: [...document.querySelectorAll('.see-through *')].filter((el) => getComputedStyle(el).backdropFilter !== 'none').length,
      veil: Boolean(document.querySelector('.see-through__fade > i')),
      opaque,
      // The copies slide with the picture: wherever the window is, they sit on it.
      aligned: shifts.every((shift) => shift.style.transform === layer.style.transform && shift.style.width === layer.style.width)
    }
  })
  assert.equal(fade.frosted, 0, 'no frosted layer is left behind the page to blur on every frame')
  assert.ok(fade.veil, "the page's colour still dims the lower part")
  assert.deepEqual(fade.opaque, [true, true, true, true, true, true], 'every step holds the picture')
  assert.ok(fade.aligned, 'the steps sit on the picture')

  // Fade out off: the steps go with it.
  await page.eval(async () => {
    const { appearance } = await window.api.settings.get()
    await window.api.settings.patch({ appearance: { ...appearance, seeThrough: { ...appearance.seeThrough, fade: false } } })
  })
  await page.reload()
  await page.waitFor(() => Boolean(document.querySelector('.see-through[data-ready]')), { timeout: 30_000, message: 'the picture again' })
  await page.waitFor(() => !document.querySelector('.see-through__baked') && !document.querySelector('.see-through__fade'), {
    message: 'Fade out gone with its setting'
  })
})
