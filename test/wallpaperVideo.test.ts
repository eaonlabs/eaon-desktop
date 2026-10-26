import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isVideoWallpaper } from '@shared/types'
import { WALLPAPER_SCHEME, wallpaperVideoUrl } from '@shared/wallpaper'

/** A chosen wallpaper can be a video (Settings → Appearance), played from Eaon's own copy. */

test('a video is told from a picture by its file type', () => {
  for (const path of ['/w/wallpaper-1.mp4', '/w/wallpaper-1.MOV', '/w/a.m4v', 'C:\\w\\a.webm']) assert.equal(isVideoWallpaper(path), true, path)
  for (const path of ['/w/wallpaper-1.jpg', '/w/a.heic', '/w/mp4', null, undefined, '']) assert.equal(isVideoWallpaper(path), false, String(path))
})

test('the page loads it by name only, through the wallpaper scheme', () => {
  assert.equal(wallpaperVideoUrl('/Users/me/Library/Eaon/wallpapers/wallpaper-17.mp4'), `${WALLPAPER_SCHEME}://wallpaper/wallpaper-17.mp4`)
  assert.equal(wallpaperVideoUrl('C:\\Users\\me\\Eaon\\wallpapers\\clip #2.mov'), `${WALLPAPER_SCHEME}://wallpaper/clip%20%232.mov`)
})
