import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.perlica.endfieldbaker',
  appName: '终末地烘焙聊天',
  webDir: 'dist',
  // 打包端(APK)通过 @capacitor/filesystem 把对话历史写入应用数据目录 JSON 文件
}

export default config
