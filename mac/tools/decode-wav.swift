// Decodes any CoreAudio-supported input (HE-AAC m4a included) to 16-bit PCM WAV.
// Usage: decode-wav <input.m4a> <output.wav>
import AVFoundation
import Foundation

guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write("usage: decode-wav <input> <output.wav>\n".data(using: .utf8)!)
    exit(2)
}
let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

let asset = AVURLAsset(url: inputURL)
guard let audioTrack = try await asset.loadTracks(withMediaType: .audio).first else {
    FileHandle.standardError.write("no audio track\n".data(using: .utf8)!)
    exit(1)
}

let reader = try AVAssetReader(asset: asset)
let outputSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false,
]
let readerOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
reader.add(readerOutput)
guard reader.startReading() else {
    FileHandle.standardError.write("startReading failed: \(reader.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    exit(1)
}

var pcm = Data()
while let chunk = readerOutput.copyNextSampleBuffer() {
    if let block = CMSampleBufferGetDataBuffer(chunk) {
        let length = CMBlockBufferGetDataLength(block)
        var buffer = [UInt8](repeating: 0, count: length)
        CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &buffer)
        pcm.append(contentsOf: buffer)
    }
}
guard reader.status == .completed else {
    FileHandle.standardError.write("decode stopped: \(reader.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    exit(1)
}

var channels = 2
var sampleRate = 44100.0
if let desc = try await audioTrack.load(.formatDescriptions).first,
   let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) {
    channels = Int(asbd.pointee.mChannelsPerFrame)
    sampleRate = asbd.pointee.mSampleRate
}

func le32(_ v: UInt32) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)] }
func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }

var wav = [UInt8]()
let dataLen = UInt32(pcm.count)
let byteRate = UInt32(sampleRate * 2 * Double(channels))
wav += Array("RIFF".utf8)
wav += le32(36 + dataLen)
wav += Array("WAVE".utf8)
wav += Array("fmt ".utf8)
wav += le32(16)
wav += le16(1) // PCM
wav += le16(UInt16(channels))
wav += le32(UInt32(sampleRate))
wav += le32(byteRate)
wav += le16(UInt16(2 * channels))
wav += le16(16)
wav += Array("data".utf8)
wav += le32(dataLen)
wav += Array(pcm)

try Data(wav).write(to: outputURL)
FileHandle.standardError.write("ok \(channels)ch \(Int(sampleRate))Hz \(pcm.count)B\n".data(using: .utf8)!)
