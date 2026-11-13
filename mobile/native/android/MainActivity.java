package app.myturn.talker;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TabletSpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
