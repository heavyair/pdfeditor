import { describe, expect, it } from 'vitest'
import { chunkPages, describeGroup, parsePageList, parseRangeGroups } from './ranges'

describe('ranges', () => {
  it('parses page lists', () => {
    expect(parsePageList('', 3)).toEqual([0, 1, 2])
    expect(parsePageList('1-3, 5', 6)).toEqual([0, 1, 2, 4])
    expect(parsePageList('4-', 6)).toEqual([3, 4, 5])
    expect(parsePageList('-2', 6)).toEqual([0, 1])
    expect(parsePageList('3-1', 6)).toEqual([2, 1, 0])
  })
  it('rejects invalid ranges', () => {
    expect(() => parsePageList('0', 3)).toThrow()
    expect(() => parsePageList('4', 3)).toThrow()
    expect(() => parsePageList('a-b', 3)).toThrow()
  })
  it('parses range groups', () => {
    expect(parseRangeGroups('1-2, 3, 4-5', 5)).toEqual([[0, 1], [2], [3, 4]])
    expect(() => parseRangeGroups(' , ', 5)).toThrow()
  })
  it('chunks and describes', () => {
    expect(chunkPages(5, 2)).toEqual([[0, 1], [2, 3], [4]])
    expect(describeGroup([0, 1, 2])).toBe('1-3')
    expect(describeGroup([4])).toBe('5')
    expect(describeGroup([0, 2])).toBe('1_3')
  })
})
