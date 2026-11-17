import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deviceTurn, forPeople, screenCorner, toNative, turned } from '../src/shared/simulatorPane'
import { buttonMessage, guessScale, JpegFrames, jpegSize, keyFrames, readConfig, TAG, textFrames, touchMessage } from '../src/main/features/simulatorInput'
import { readEndpoints } from '../src/main/features/simulatorPane'

/* The Device pane's pieces that need no simulator: serve-sim's messages, cutting frames out of its stream, turning the picture. */

/** A minimal JPEG: start, a baseline frame header saying `width`×`height`, then `body`, then the end. */
function jpeg(width: number, height: number, body: number[] = [0x12, 0x34]): Buffer {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, ...sof, ...body, 0xff, 0xd9])
}

const decode = (data: Buffer): { tag: number; json: unknown } => ({ tag: data[0], json: JSON.parse(data.subarray(1).toString('utf8')) })

test("serve-sim's messages: a tag byte, then JSON", () => {
  assert.deepEqual(decode(touchMessage({ type: 'begin', x: 0.5, y: 0.25 })), { tag: 0x03, json: { type: 'begin', x: 0.5, y: 0.25 } })
  assert.deepEqual(decode(buttonMessage('home')), { tag: 0x04, json: { button: 'home' } })
  assert.deepEqual(decode(buttonMessage('lock')), { tag: 0x04, json: { button: 'power', page: 12, usage: 48 } })
  const config = Buffer.concat([Buffer.from([TAG.config]), Buffer.from('{"width":1206,"height":2622,"orientation":"landscape_left"}')])
  assert.deepEqual(readConfig(config), { width: 1206, height: 2622, orientation: 'landscape_left' })
  assert.equal(readConfig(touchMessage({ type: 'end', x: 0, y: 0 })), null)
})

test('keys and text as USB HID usages, with Shift where the US keyboard needs it', () => {
  assert.deepEqual(keyFrames('a'), [{ type: 'down', usage: 4 }, { type: 'up', usage: 4 }])
  assert.deepEqual(keyFrames('A'), [{ type: 'down', usage: 225 }, { type: 'down', usage: 4 }, { type: 'up', usage: 4 }, { type: 'up', usage: 225 }])
  assert.deepEqual(keyFrames('Enter'), [{ type: 'down', usage: 40 }, { type: 'up', usage: 40 }])
  assert.deepEqual(keyFrames('Backspace')?.[0], { type: 'down', usage: 42 })
  assert.equal(keyFrames('F13'), null)
  assert.equal(textFrames('Hi!')?.length, 10)
  assert.deepEqual(textFrames('1 2')?.map((f) => f.usage), [30, 30, 44, 44, 31, 31])
  // Not on a US keyboard: it goes by the pasteboard instead.
  assert.equal(textFrames('café'), null)
})

test('the endpoints serve-sim --detach prints', () => {
  assert.deepEqual(readEndpoints('starting…\n{"url":"http://127.0.0.1:3100","streamUrl":"http://127.0.0.1:3100/stream.mjpeg","wsUrl":"ws://127.0.0.1:3100/ws","port":3100,"device":"U"}\n'), {
    streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
    wsUrl: 'ws://127.0.0.1:3100/ws'
  })
  assert.deepEqual(readEndpoints('{"url":"http://127.0.0.1:3101/","wsUrl":"ws://127.0.0.1:3101/ws"}'), { streamUrl: 'http://127.0.0.1:3101/stream.mjpeg', wsUrl: 'ws://127.0.0.1:3101/ws' })
  assert.equal(readEndpoints('No device specified and no available iOS simulator found.'), null)
})

test('frames are cut from a stream however it arrives: split across chunks, between part headers, newest kept', () => {
  const a = jpeg(10, 20)
  const b = jpeg(30, 40, [0xff, 0x00, 0x55])
  const reader = new JpegFrames()
  assert.equal(reader.push(a.subarray(0, 7)), null)
  assert.deepEqual(reader.push(a.subarray(7)), a)
  const header = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
  assert.deepEqual(reader.push(Buffer.concat([header, a, header, b])), b)
  assert.equal(reader.push(Buffer.concat([header, b.subarray(0, 1)])), null)
  assert.deepEqual(reader.push(b.subarray(1)), b)
  assert.deepEqual(jpegSize(jpeg(1206, 2622)), { width: 1206, height: 2622 })
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0x00])), null)
})

test('turning: the picture follows the device, and a touch on it maps back to the native frame', () => {
  assert.equal(turned('portrait', 'right'), 'landscape_left')
  assert.equal(turned('portrait', 'left'), 'landscape_right')
  assert.equal(turned('landscape_right', 'right'), 'portrait')
  assert.equal(deviceTurn('portrait'), 0)
  assert.equal(deviceTurn('landscape_left'), 90)
  assert.equal(deviceTurn('landscape_right'), -90)
  assert.equal(deviceTurn('portrait_upside_down'), 180)
  // The top left of the picture turned a quarter clockwise is the native frame's bottom left.
  assert.deepEqual(toNative({ x: 0, y: 0 }, 90), { x: 0, y: 1 })
  assert.deepEqual(toNative({ x: 0, y: 0 }, -90), { x: 1, y: 0 })
  assert.deepEqual(toNative({ x: 0.25, y: 0.5 }, 180), { x: 0.75, y: 0.5 })
  assert.deepEqual(toNative({ x: 0.3, y: 0.7 }, 0), { x: 0.3, y: 0.7 })
})

test('devices: scale and screen corners from the name', () => {
  assert.equal(guessScale('iPhone 17 Pro'), 3)
  assert.equal(guessScale('iPhone SE (3rd generation)'), 2)
  assert.equal(guessScale('iPad Air 11-inch (M3)'), 2)
  assert.equal(screenCorner('iPhone SE (3rd generation)'), 0)
  assert.ok(screenCorner('iPhone 17') > 0.1)
})

test("the tool's messages, put for the person reading the pane", () => {
  assert.equal(
    forPeople('Xcode is installed, but the Command Line Tools are selected. Ask the user to run `sudo xcode-select -s /x`, or to choose Xcode in Settings, then try again.'),
    'Xcode is installed, but the Command Line Tools are selected. Run “sudo xcode-select -s /x”, or choose Xcode in Settings.'
  )
})
