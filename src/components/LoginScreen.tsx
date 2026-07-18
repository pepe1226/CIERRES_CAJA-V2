import { memo } from 'react';
import { ArrowRight, DollarSign, User } from 'lucide-react';
import { motion } from 'motion/react';

type LoginScreenProps = {
  onLogin: () => void;
};

export const LoginScreen = memo(function LoginScreen({ onLogin }: LoginScreenProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0F172A] p-4">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full bg-[#1E293B]/80 backdrop-blur-xl rounded-[2.5rem] shadow-2xl p-10 text-center border border-white/10"
      >
        <div className="w-24 h-24 bg-gradient-to-br from-blue-500 to-blue-700 rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-xl shadow-blue-500/20">
          <DollarSign className="w-12 h-12 text-white" />
        </div>
        <h1 className="text-4xl font-black text-white mb-4 tracking-tight">CIERRES 1.1</h1>
        <p className="text-slate-400 mb-10 leading-relaxed text-lg">Gestiona tus cierres de caja en la nube.</p>
        <button type="button" onClick={onLogin} className="w-full py-5 bg-white text-[#0F172A] rounded-2xl font-black text-lg hover:bg-slate-100 transition-all shadow-xl flex items-center justify-center gap-3">
          <User className="w-6 h-6" />
          Ingresar con Google
          <ArrowRight className="w-5 h-5" />
        </button>
      </motion.div>
    </div>
  );
});
