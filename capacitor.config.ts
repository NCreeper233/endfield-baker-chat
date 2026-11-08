import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.perlica.endfieldbaker',
  appName: 'Baker AI',
  webDir: 'dist',
  // APK 通过 @capacitor/filesystem 把对话历史写入应用数据目录的 JSON 文件
}

export default config
